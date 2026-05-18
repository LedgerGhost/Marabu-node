import { MarabuPeer } from './marabupeer'
import { log } from '../log'
import conf from '../conf'
import { addrToString, type Addr, isPrivateAddr, parseAddr } from './util'
import net from 'net'
import * as fs from 'fs'
import canonicalize from 'canonicalize'
import * as z from 'zod'
import type { MarabuObject } from './protocol'

export class PeerManager {
  // connections contains all peers which I am currently connected to,
  // or those I am attempting a connection to
  connections: Set<MarabuPeer> = new Set<MarabuPeer>()
  knownPeerAddrs = new Set<string>()
  myPublicHost: string

  // objectWaiters: callbacks notified when an object arrives via handleObject
  private objectWaiters = new Map<string, ((oid: string, obj: any) => void)[]>()

  // candidateObjects are objects we received and are currently validating.
  // They are not served or gossiped as valid, but they can satisfy internal
  // dependency lookups so out-of-order block chains do not trigger refetches.
  private candidateObjects = new Map<string, MarabuObject>()

  // Peers that claimed to have or directly sent a given object.
  private objectSources = new Map<string, Set<MarabuPeer>>()

  // inFlightFetches: deduplicates concurrent requestObjectFromPeers calls for the same id
  private inFlightFetches = new Map<string, Promise<any | null>>()

  // pendingServes: when a getobject arrives for an object not yet stored,
  // we register a pending response here and fulfil it once the block is stored.
  private pendingServes = new Map<string, { resolve: (obj: MarabuObject | null) => void, timer: ReturnType<typeof setTimeout> }[]>()

  // object ids currently being processed. getobject requests for these may
  // wait for validation; unrelated unknown ids should fail immediately.
  private processingObjects = new Set<string>()

  constructor(myPublicHost: string) {
    this.myPublicHost = myPublicHost
  }

  // ── Object waiter API (used by requestObjectFromPeers) ────────────────────

  registerObjectWaiter(objectid: string, handler: (oid: string, obj: any) => void) {
    const candidate = this.candidateObjects.get(objectid)
    if (candidate !== undefined) {
      queueMicrotask(() => handler(objectid, candidate))
      return
    }
    const existing = this.objectWaiters.get(objectid) || []
    existing.push(handler)
    this.objectWaiters.set(objectid, existing)
  }
  removeObjectWaiter(objectid: string) {
    this.objectWaiters.delete(objectid)
  }
  notifyObjectWaiters(objectid: string, obj: any): boolean {
    const waiters = this.objectWaiters.get(objectid)
    if (waiters && waiters.length > 0) {
      for (const handler of waiters) {
        try { handler(objectid, obj) } catch { }
      }
      this.objectWaiters.delete(objectid)
      return true
    }
    return false
  }

  rememberCandidateObject(objectid: string, obj: MarabuObject): void {
    this.candidateObjects.set(objectid, obj)
  }

  getCandidateObject(objectid: string): MarabuObject | undefined {
    return this.candidateObjects.get(objectid)
  }

  forgetCandidateObject(objectid: string): void {
    this.candidateObjects.delete(objectid)
  }

  noteObjectSource(objectid: string, peer: MarabuPeer): void {
    let sources = this.objectSources.get(objectid)
    if (sources === undefined) {
      sources = new Set<MarabuPeer>()
      this.objectSources.set(objectid, sources)
    }
    sources.add(peer)
  }

  markObjectProcessing(objectid: string): void {
    this.processingObjects.add(objectid)
  }

  isObjectProcessing(objectid: string): boolean {
    return this.processingObjects.has(objectid)
  }

  finishObjectProcessing(objectid: string, obj: MarabuObject | null): void {
    this.processingObjects.delete(objectid)
    this.forgetCandidateObject(objectid)
    if (obj === null) {
      this.rejectPendingServes(objectid)
    } else {
      this.fulfillPendingServes(objectid, obj)
    }
  }

  // ── Deduplicated network fetch ────────────────────────────────────────────

  /**
   * Fetch an object from any connected peer, deduplicating concurrent requests.
   * If another caller is already waiting for `objectid`, the same Promise is
   * returned so only one round of getobject messages is sent.
   */
  fetchObject(
    objectid: string,
    timeoutMs: number = 5000,
    preferredPeers: MarabuPeer[] = []
  ): Promise<any | null> {
    const candidate = this.candidateObjects.get(objectid)
    if (candidate !== undefined) {
      return Promise.resolve(candidate)
    }

    const existing = this.inFlightFetches.get(objectid)
    if (existing !== undefined) {
      return existing
    }

    const promise = new Promise<any | null>((resolve) => {
      let resolved = false
      const requestedPeers = new Set<MarabuPeer>()
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
          this.inFlightFetches.delete(objectid)
          this.removeObjectWaiter(objectid)
          resolve(null)
        }
      }, timeoutMs)

      this.registerObjectWaiter(objectid, (_oid: string, obj: any) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
          this.inFlightFetches.delete(objectid)
          resolve(obj)
        }
      })

      const sendRequests = (peers: Iterable<MarabuPeer>) => {
        for (const peer of peers) {
          if (requestedPeers.has(peer)) continue
          if (peer.socket.destroyed || peer.socket.readyState !== 'open') continue
          requestedPeers.add(peer)
          peer.sendGetObject(objectid)
        }
      }

      sendRequests(preferredPeers)
      const sources = this.objectSources.get(objectid)
      if (sources !== undefined) {
        sendRequests(sources)
      }

      if (requestedPeers.size === 0) {
        sendRequests(this.connections)
      } else {
        const fallbackMs = Math.min(2000, Math.max(250, Math.floor(timeoutMs / 2)))
        fallbackTimer = setTimeout(() => {
          if (!resolved) sendRequests(this.connections)
        }, fallbackMs)
      }
    })

    this.inFlightFetches.set(objectid, promise)
    return promise
  }

  // ── Pending-serve API (deferred getobject responses) ──────────────────────

  /**
   * Register a deferred response for a getobject request.
   * `callback` is called with the object once it becomes available,
   * or with null if `timeoutMs` elapses first.
   */
  registerPendingServe(
    objectid: string,
    callback: (obj: MarabuObject | null) => void,
    timeoutMs: number = 8000
  ): void {
    const timer = setTimeout(() => {
      callback(null)
      const list = this.pendingServes.get(objectid)
      if (list) {
        this.pendingServes.set(objectid, list.filter(e => e.resolve !== callback))
        if (this.pendingServes.get(objectid)!.length === 0) {
          this.pendingServes.delete(objectid)
        }
      }
    }, timeoutMs)

    const list = this.pendingServes.get(objectid) || []
    list.push({ resolve: callback, timer })
    this.pendingServes.set(objectid, list)
  }

  /**
   * Notify all pending getobject waiters for `objectid` that the object is
   * now available. Called after a block is successfully validated and stored.
   */
  fulfillPendingServes(objectid: string, obj: MarabuObject): void {
    const list = this.pendingServes.get(objectid)
    if (list && list.length > 0) {
      for (const { resolve, timer } of list) {
        clearTimeout(timer)
        resolve(obj)
      }
      this.pendingServes.delete(objectid)
    }
  }

  rejectPendingServes(objectid: string): void {
    const list = this.pendingServes.get(objectid)
    if (list && list.length > 0) {
      for (const { resolve, timer } of list) {
        clearTimeout(timer)
        resolve(null)
      }
      this.pendingServes.delete(objectid)
    }
  }

  // ── Connection management ─────────────────────────────────────────────────

  getKnownPeerAddrs(): string[] {
    const addrs = Array.from(this.knownPeerAddrs.values())
    addrs.unshift(addrToString([this.myPublicHost, conf.SERVER_PORT]))
    return addrs
  }
  async addKnownPeers(peerAddrs: string[]) {
    const sanitizedAddrs = new Set<string>()

    for (let peerAddr of peerAddrs) {
      let addr: Addr

      log.debug(`Validating peer address ${peerAddr}`)
      try {
        addr = await parseAddr(peerAddr)
      }
      catch (e: any) {
        log.warn(`Rejecting invalid peer address "${peerAddr}": ${e.message}`)
        continue
      }
      try {
        if (await isPrivateAddr(addr[0])) {
          log.warn(`Rejecting private peer address "${addr[0]}"`)
          continue
        }
      }
      catch (e) {
        log.warn(`Rejecting unresolvable address "${addr[0]}"`)
        continue
      }
      const addrStr = addrToString(addr)
      if (this.knownPeerAddrs.has(addrStr)) {
        log.debug(`Peer is already known`)
        continue
      }
      log.info(`Discovered new peer ${peerAddr}`)
      sanitizedAddrs.add(addrStr)
    }
    let numPeersBefore = this.knownPeerAddrs.size
    this.knownPeerAddrs = this.knownPeerAddrs.union(sanitizedAddrs)
    let numPeersAfter = this.knownPeerAddrs.size

    if (numPeersAfter > numPeersBefore) {
      this.save()
    }
    await this.connectSufficiently()
  }
  addConnection(peer: MarabuPeer) {
    this.connections.add(peer)
  }
  async removeConnection(peer: MarabuPeer) {
    this.connections.delete(peer)
    for (const [objectid, sources] of this.objectSources) {
      sources.delete(peer)
      if (sources.size === 0) {
        this.objectSources.delete(objectid)
      }
    }
    await this.connectSufficiently()
  }
  async connectSufficiently() {
    const connectedAddrs = new Set<string>()

    for (let connection of this.connections) {
      if (connection.socket.remoteAddress === undefined
        || connection.socket.remotePort === undefined) {
        continue
      }
      connectedAddrs.add(addrToString([connection.socket.remoteAddress, connection.socket.remotePort]))
    }
    const candidateAddrs: string[] = Array.from(this.knownPeerAddrs.difference(connectedAddrs))
    while (this.connections.size < conf.TARGET_NUM_CONNECTIONS) {
      log.debug(`We have ${this.connections.size} active connections, trying to increase our neighbours`)
      if (candidateAddrs.length === 0) {
        log.info(`Not enough known peers to connect to. Already connected to all ${connectedAddrs.size} peers.`)
        return
      }
      const index = Math.floor(Math.random() * candidateAddrs.length)
      const candidateAddr = candidateAddrs[index]
      if (candidateAddr === undefined) {
        throw new Error(`Expected to find missing candidate address at index ${index}`)
      }
      candidateAddrs.splice(index, 1)
      try {
        this.connect(await parseAddr(candidateAddr))
      } catch (e: any) {
        log.warn(`Skipping invalid peer candidate "${candidateAddr}": ${e.message}`)
        this.knownPeerAddrs.delete(candidateAddr)
        this.save()
      }
    }
  }
  connect(addr: Addr) {
    const [host, port] = addr
    const client = new net.Socket()
    client.connect(port, host)

    return new MarabuPeer(client, this, true)
  }
  broadcastIHaveObject(objectid: string) {
    for (const peer of this.connections) {
      if (peer.socket.destroyed || peer.socket.readyState !== 'open') continue
      peer.sendIHaveObject(objectid)
    }
  }
  save() {
    log.debug(`Persisting ${this.knownPeerAddrs.size} peers to file`)
    const json: string = canonicalize(Array.from(this.knownPeerAddrs))!

    try {
      fs.writeFileSync(conf.PEERS_FILE, json, { encoding: 'utf8' })
    }
    catch (e: any) {
      log.warn(`Failed to write to peers file "${conf.PEERS_FILE}": ${e.message}`)
    }
  }
  async restore() {
    log.debug(`Restoring peers from file`)
    let json: string
    let peers: string[]

    try {
      json = fs.readFileSync(conf.PEERS_FILE, { encoding: 'utf8' })
      peers = z.array(z.string()).parse(JSON.parse(json))
    }
    catch (e: any) {
      log.info(`Failed to read peers file ${conf.PEERS_FILE}. Initializing file.`)
      let bootstrapAddrs: string[] = []
      for (let addrStr of conf.BOOTSTRAP_PEERS) {
        bootstrapAddrs.push(addrStr)
      }
      this.knownPeerAddrs = new Set(bootstrapAddrs)
      log.info(`Initialized peers file with ${bootstrapAddrs.length} bootstrapping peers`)
      this.save()
      return
    }
    this.knownPeerAddrs = new Set(peers)
  }
}
