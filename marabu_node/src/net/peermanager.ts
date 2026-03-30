import { MarabuPeer } from './marabupeer'
import { log } from '../log'
import conf from '../conf'
import { type Addr, isPrivateAddr, parseAddr } from './util'
import net from 'net'
import * as fs from 'fs'
import canonicalize from 'canonicalize'
import * as z from 'zod'

export class PeerManager {
  // connections contains all peers which I am currently connected to,
  // or those I am attempting a connection to
  connections: Set<MarabuPeer> = new Set<MarabuPeer>()
  knownPeerAddrs = new Set<string>()
  myPublicHost: string
  private objectWaiters = new Map<string, ((oid: string, obj: any) => void)[]>()

  constructor(myPublicHost: string) {
    this.myPublicHost = myPublicHost
  }
  registerObjectWaiter(objectid: string, handler: (oid: string, obj: any) => void) {
    const existing = this.objectWaiters.get(objectid) || []
    existing.push(handler)
    this.objectWaiters.set(objectid, existing)
  }
  removeObjectWaiter(objectid: string) {
    this.objectWaiters.delete(objectid)
  }
  notifyObjectWaiters(objectid: string, obj: any) {
    const waiters = this.objectWaiters.get(objectid)
    if (waiters && waiters.length > 0) {
      for (const handler of waiters) {
        try { handler(objectid, obj) } catch { }
      }
      this.objectWaiters.delete(objectid)
    }
  }
  getKnownPeerAddrs(): string[] {
    const addrs = Array.from(this.knownPeerAddrs.values())
    addrs.unshift(`${this.myPublicHost}:${conf.SERVER_PORT}`)
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
      const addrStr: string = `${addr[0]}:${addr[1]}`
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
    await this.connectSufficiently()
  }
  async connectSufficiently() {
    const connectedAddrs = new Set<string>()

    for (let connection of this.connections) {
      if (connection.socket.remoteAddress === undefined
        || connection.socket.remotePort === undefined) {
        continue
      }
      connectedAddrs.add(`${connection.socket.remoteAddress}:${connection.socket.remotePort}`)
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
      this.connect(await parseAddr(candidateAddr))
    }
  }
  connect(addr: Addr) {
    const [host, port] = addr
    const client = new net.Socket()
    client.connect(port, host)

    return new MarabuPeer(client, this)
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