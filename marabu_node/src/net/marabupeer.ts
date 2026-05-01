import { Peer } from './peer'
import conf from '../conf'
import {
  MessageSchema, type Message,
  type HelloMessage,
  type ErrorMessage,
  type GetPeersMessage,
  type PeersMessage,
  type IHaveObjectMessage,
  type GetObjectMessage,
  type ObjectMessage,
  type GetMempoolMessage,
  type MempoolMessage,
  type GetChainTipMessage,
  type ChainTipMessage,
  type MarabuError,
  type MarabuObject,
  type MarabuBlockObject,
  type MarabuTxObject,
  MarabuObjectSchema
} from './protocol'
import * as semver from 'semver'
import { Socket } from 'net'
import type { PeerManager } from './peermanager'
import { log } from '../log'
import canonicalize from 'canonicalize'
import { hash, validateObject, objectManager } from '../objectmanager'
import { validateAndStoreBlock, preValidateBlock } from '../block'
import { getChainTip, maybeUpdateChainTip } from '../chain'

const PROTOCOL_VERSION = '0.10.0'
const PROTOCOL_COMPATIBLE_VERSIONS = '0.10.x'

type MessageHandler<T> = (this: MarabuPeer, message: T) => Promise<void>
const handlers = new Map<Message["type"], MessageHandler<Message>>()
const mempoolTxids = new Set<string>()

export class MarabuPeer extends Peer {
  handshook = false
  peerManager: PeerManager

  constructor(socket: Socket, peerManager: PeerManager) {
    super(socket)
    this.peerManager = peerManager
    this.peerManager.addConnection(this)
    if (socket.readyState === 'open') {
      this.onConnect()
    }
    else {
      socket.on('connect', () => this.onConnect())
    }
    socket.on('error', err => {
      this.error(`Socket produced error: ${err}`, 'INTERNAL_ERROR', false)
    })
    socket.on('timeout', () => {
      this.error(`Socket timed out`, 'INTERNAL_ERROR', false)
    })
    socket.on('finish', () => {
      this.error(`Socket finished`, 'INTERNAL_ERROR', false)
    })
  }
  onConnect() {
    this.sendHello()
    this.sendGetPeers()
    // pset4: ask peers for their chain tip on bootstrap
    this.sendGetChainTip()
  }
  protected override onNetworkMessage(message: any) {
    let parsedMessage: Message | undefined

    try {
      parsedMessage = MessageSchema.parse(message)
    }
    catch (e: any) {
      this.onParseError(`Error "${e.message}" when parsing protocol message: ${canonicalize(message)}`)
      return
    }
    this.log.debug(`Parsed protocol message of type ${parsedMessage.type}`)
    this.dispatchMessage(parsedMessage)
  }
  protected override onParseError(description: string) {
    this.error(description, 'INVALID_FORMAT')
  }
  async dispatchMessage(message: Message) {
    const handler = handlers.get(message.type)
    if (!this.handshook && message.type !== 'hello') {
      return this.error(`Received a message of type "${message.type}" prior to handshake`, 'INVALID_HANDSHAKE')
    }
    if (handler === undefined) {
      return this.error(`No handler for message type ${message.type}`, 'INVALID_FORMAT')
    }
    try {
      await handler.call(this, message)
    }
    catch (e: any) {
      this.log.warn(`Handler for ${message.type} threw: ${e?.message ?? e}`)
      if (e?.stack) this.log.debug(e.stack)
    }
  }
  @handle('hello')
  async handleHello(message: HelloMessage) {
    this.log.info(`Peer handshook with agent "${message.agent}" and version ${message.version}`)
    if (!semver.satisfies(message.version, PROTOCOL_COMPATIBLE_VERSIONS)) {
      return this.error(`Peer is running incompatible version ${message.version}`, 'INVALID_FORMAT')
    }
    this.handshook = true
    this.log.info('Handshake completed')
  }
  @handle('getpeers')
  async handleGetPeers(_: GetPeersMessage) {
    this.sendPeers()
  }
  @handle('peers')
  async handlePeers(message: PeersMessage) {
    const peersToStore: string[] = message.peers.slice(0, conf.MAX_PEERS_PER_NEIGHBOUR)
    this.peerManager.addKnownPeers(peersToStore)
  }
  @handle('error')
  async handleError(message: ErrorMessage) {
    this.error(`Peer reports error ${message.name}: ${message.description}`)
  }
  @handle('ihaveobject')
  async handleIHaveObject(message: IHaveObjectMessage) {
    if (!await objectManager.has(message.objectid)) {
      this.sendGetObject(message.objectid)
    }
  }
  @handle('getobject')
  async handleGetObject(message: GetObjectMessage) {
    const obj = await objectManager.get(message.objectid)
    if (obj !== undefined) {
      this.sendObject(obj)
      return
    }

    if (!this.peerManager.isObjectProcessing(message.objectid)) {
      this.sendError('UNKNOWN_OBJECT', `Object with id ${message.objectid} not found`)
      return
    }

    // Object not yet in DB, but it is actively being validated. Defer the
    // response until validation either stores or rejects the object.
    return new Promise<void>((promiseResolve) => {
      this.peerManager.registerPendingServe(
        message.objectid,
        (resolved: MarabuObject | null) => {
          if (resolved !== null) {
            this.sendObject(resolved)
          } else {
            this.sendError('UNKNOWN_OBJECT', `Object with id ${message.objectid} not found`)
          }
          promiseResolve()
        },
        8000
      )
    })
  }
  @handle('object')
  async handleObject(message: ObjectMessage) {
    let object: MarabuObject
    try {
      object = MarabuObjectSchema.parse(message.object)
    } catch (e: any) {
      return this.error(`Invalid application object: ${e.message}`, 'INVALID_FORMAT')
    }

    const objectid = hash(message.object)
    if (objectid === undefined) {
      return this.error('Received unhashable object', 'INVALID_FORMAT')
    }

    // Notify any pending fetcher waiting for this object id.
    this.peerManager.notifyObjectWaiters(objectid, object)

    if (await objectManager.has(objectid)) {
      // Already known and previously accepted as valid.
      this.log.debug(`Already known object ${objectid}; gossiping`)
      this.gossipIHaveObject(objectid)
      return
    }

    this.peerManager.markObjectProcessing(objectid)
    try {
      if (object.type === 'block') {
        await this.handleBlockObject(object as MarabuBlockObject, objectid)
      } else {
        await this.handleTransactionObject(object as MarabuTxObject, objectid)
      }
    } finally {
      const stored = await objectManager.get(objectid)
      this.peerManager.finishObjectProcessing(objectid, stored ?? null)
    }
  }
  @handle('getmempool')
  async handleGetMempool(_: GetMempoolMessage) {
    this.sendMessage({ type: 'mempool', txids: Array.from(mempoolTxids) } satisfies MempoolMessage)
  }
  @handle('mempool')
  async handleMempool(_: MempoolMessage) {
    // Not yet used; ignore.
  }
  @handle('getchaintip')
  async handleGetChainTip(_: GetChainTipMessage) {
    const tip = await getChainTip()
    if (tip === null) return
    this.sendChainTip(tip.blockid)
  }
  @handle('chaintip')
  async handleChainTip(message: ChainTipMessage) {
    if (await objectManager.has(message.blockid)) return

    this.log.info(`Peer advertises chain tip ${message.blockid}; fetching`)
    const obj = await this.requestObjectFromPeer(message.blockid)
    if (obj === null) {
      this.log.warn(`Could not fetch chain tip ${message.blockid} from peers`)
      return
    }
    if (obj?.type !== 'block') {
      this.log.warn(`Chain tip ${message.blockid} is not a block`)
      return
    }
    const objectid = hash(obj)
    if (objectid === undefined) return
    await this.handleBlockObject(obj as MarabuBlockObject, objectid)
  }
  private async handleTransactionObject(tx: MarabuTxObject, objectid: string) {
    const [_, err, desc] = await validateObject(tx)
    if (err !== undefined && desc !== undefined) {
      return this.error(desc, err)
    }
    await objectManager.put(tx)
    mempoolTxids.add(objectid)
    this.gossipIHaveObject(objectid)
  }
  private async handleBlockObject(blockRaw: MarabuBlockObject, blockid: string) {
    this.log.info(`Processing block ${blockid}`)

    // Per pset3: format + target + PoW must be checked BEFORE going to
    // the network for missing transactions or parents. This prevents an
    // attacker from triggering network I/O with malformed/PoW-invalid blocks.
    const preCheck = preValidateBlock(blockRaw, blockid)
    if (preCheck !== null) {
      this.log.warn(`Block ${blockid} rejected: [${preCheck.error}] ${preCheck.description}`)
      return this.error(preCheck.description, preCheck.error)
    }

    // Full validation. The fetchObject callback is used for both parent blocks
    // and transactions — no separate pre-fetch loop here, so that timestamp and
    // other block-level errors take priority over UNFINDABLE_OBJECT for txids.
    const result = await validateAndStoreBlock(blockRaw, async (objectid: string) => {
      // Check local DB first (handles the case where we already have it).
      const local = await objectManager.get(objectid)
      if (local !== undefined) return local
      // Otherwise ask peers (deduplicated by PeerManager.fetchObject).
      return await this.requestObjectFromPeer(objectid)
    })

    if (!result.valid) {
      this.log.warn(`Block ${blockid} invalid: [${result.error}] ${result.description}`)
      return this.error(result.description, result.error)
    }

    // Block validated and stored. Notify any object waiters, e.g. concurrent
    // validators that need this block as a parent.
    const storedBlock = await objectManager.get(result.blockid)
    if (storedBlock !== undefined) {
      this.peerManager.notifyObjectWaiters(result.blockid, storedBlock)
    }

    await maybeUpdateChainTip(result.blockid)
    for (const txid of blockRaw.txids) {
      mempoolTxids.delete(txid)
    }
    this.gossipIHaveObject(blockid)
  }
  /**
   * Broadcast an ihaveobject for a known good object to all peers.
   */
  private gossipIHaveObject(objectid: string) {
    for (const peer of this.peerManager.connections) {
      if (peer === this) continue
      peer.sendIHaveObject(objectid)
    }
    // Also advertise back to the sender.
    this.sendIHaveObject(objectid)
  }
  /**
   * Request a single object from peers, deduplicating concurrent requests
   * via PeerManager.fetchObject.
   */
  private async requestObjectFromPeer(objectid: string, timeoutMs: number = 5000): Promise<any | null> {
    return this.peerManager.fetchObject(objectid, timeoutMs)
  }
  sendHello() {
    const helloMessage: HelloMessage = {
      type: 'hello',
      version: PROTOCOL_VERSION,
      agent: `${conf.AGENT_NAME} ${conf.AGENT_VERSION}`
    }
    this.sendMessage(helloMessage)
  }
  sendGetPeers() {
    this.sendMessage({ type: 'getpeers' } satisfies GetPeersMessage)
  }
  sendPeers() {
    const peers = this.peerManager.getKnownPeerAddrs()
    this.sendMessage({ type: 'peers', peers } satisfies PeersMessage)
  }
  sendIHaveObject(objectid: string) {
    this.sendMessage({ type: 'ihaveobject', objectid } satisfies IHaveObjectMessage)
  }
  sendGetObject(objectid: string) {
    this.sendMessage({ type: 'getobject', objectid } satisfies GetObjectMessage)
  }
  sendObject(object: MarabuObject) {
    this.sendMessage({ type: 'object', object } satisfies ObjectMessage)
  }
  sendGetChainTip() {
    this.sendMessage({ type: 'getchaintip' } satisfies GetChainTipMessage)
  }
  async sendCurrentChainTip() {
    const tip = await getChainTip()
    if (tip === null) return
    this.sendChainTip(tip.blockid)
  }
  sendChainTip(blockid: string) {
    this.sendMessage({ type: 'chaintip', blockid } satisfies ChainTipMessage)
  }
  sendError(name: MarabuError, description: string) {
    this.sendMessage({ type: 'error', name, description } satisfies ErrorMessage)
  }
  protected override error(description: string, name: MarabuError = 'INTERNAL_ERROR', informPeer: boolean = true) {
    if (informPeer) {
      try {
        this.sendError(name, description)
      }
      catch {
        this.log.debug(`Failed to inform peer about "${name}" error: ${description}`)
      }
    }
    super.error(description)
    this.peerManager.removeConnection(this)
  }
}

function handle<K extends Message["type"]>(type: K) {
  return function (handler: MessageHandler<Extract<Message, { type: K }>>) {
    log.debug(`Registering handler ${handler.name} for messages of type ${type}`)
    handlers.set(type, handler as MessageHandler<Message>)
  }
}

log.debug(`Registered ${handlers.size} handlers`)
