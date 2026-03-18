import { Peer } from './peer'
import conf from '../conf'
import {
  MessageSchema, type Message,
  type HelloMessage,
  type ErrorMessage,
  type GetPeersMessage,
  type PeersMessage,
  type GetObjectMessage,
  type IHaveObjectMessage,
  type ObjectMessage,
  type GetMempoolMessage,
  type MempoolMessage,
  type GetChainTipMessage,
  type ChainTipMessage,
  type MarabuError
} from './protocol'
import * as z from 'zod'
import * as semver from 'semver'
import { Socket } from 'net'
import type { PeerManager } from './peermanager'
import { log } from '../log'
import canonicalize from 'canonicalize'
import { objectId } from '../crypto'
import { parseApplicationObject, type Transaction } from '../objects'
import { validateTransaction } from '../validation'

const PROTOCOL_VERSION = '0.10.0'
const PROTOCOL_COMPATIBLE_VERSIONS = '0.10.x'

type MessageHandler = (this: MarabuPeer, message: any) => void | Promise<void>
// holds a list of methods that handle protocol messages,
// one for each message type, for dispatching purposes
const handlers = new Map<string, MessageHandler>()

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
      this.log.warn(`Socket error: ${err}`)
      this.peerManager.removeConnection(this)
    })
    socket.on('timeout', () => {
      this.log.warn(`Socket timed out`)
      this.socket.end()
      this.peerManager.removeConnection(this)
    })
    socket.on('close', () => {
      this.log.info(`Connection closed`)
      this.peerManager.removeConnection(this)
    })
  }
  onConnect() {
    this.sendHello()
    this.sendGetPeers()
  }
  protected override onNetworkMessage(message: any) {
    let parsedMessage: Message | undefined

    try {
      parsedMessage = MessageSchema.parse(message)
    }
    catch (e) {
      if (e instanceof z.ZodError) {
        const tree = z.treeifyError<Message>(e as z.ZodError<Message>)
        if (tree.properties?.type?.errors?.includes('Invalid input')) {
          this.onParseError(`Unrecognized message type`)
          return
        }
      }
      this.onParseError(`Unknown error when parsing protocol message: ${canonicalize(message)}`)
      return
    }
    this.log.debug(`Parsed protocol message`)

    this.dispatchMessage(parsedMessage)
  }
  protected override onParseError(description: string) {
    this.error(description, 'INVALID_FORMAT')
  }
  dispatchMessage(message: Message) {
    const handler = handlers.get(message.type)
    if (!this.handshook && message.type !== 'hello') {
      return this.error(`Received a message of type "${message.type}" prior to handshake`, 'INVALID_HANDSHAKE')
    }
    if (handler === undefined) {
      return this.error(`No registered handler to handle message ${message}`)
    }
    this.log.debug(`Using handler for message of type "${message.type}"`)
    // handlers may be async (e.g. object validation requires DB lookups)
    const result = handler.call(this, message)
    if (result instanceof Promise) {
      result.catch((e: any) => {
        this.log.error(`Handler threw unexpected error: ${e.message}`)
        this.sendError('INTERNAL_ERROR', `Internal error processing message`)
      })
    }
  }

  // PSET1 handlers

  handleHello(message: HelloMessage) {
    this.log.info(`Peer handshook with agent "${message.agent}" and version ${message.version}`)
    if (!semver.satisfies(message.version, PROTOCOL_COMPATIBLE_VERSIONS)) {
      return this.error(`Peer is running incompatible version ${message.version}`, 'INVALID_FORMAT')
    }
    this.handshook = true
    this.log.info('Handshake completed')
  }
  handleGetPeers(_: GetPeersMessage) {
    this.log.info(`Peer requested our peers`)
    this.sendPeers()
  }
  handlePeers(message: PeersMessage) {
    this.log.info(`Peer reported known peers: ${message.peers}`)
    const peersToStore: string[] = message.peers.slice(0, conf.MAX_PEERS_PER_NEIGHBOUR)
    this.peerManager.addKnownPeers(peersToStore)
  }
  handleError(message: ErrorMessage) {
    this.error(`Peer reports error ${message.name}: ${message.description}`)
  }

  // PSET2 handlers

  async handleIHaveObject(message: IHaveObjectMessage) {
    const oid = message.objectid
    this.log.info(`Peer claims to have object ${oid}`)

    const exists = await this.peerManager.objectDB.has(oid)
    if (!exists) {
      this.log.info(`Object ${oid} is unknown, requesting it`)
      this.sendMessage({ type: 'getobject', objectid: oid })
    }
    else {
      this.log.debug(`Object ${oid} already in database, ignoring`)
    }
  }
  async handleGetObject(message: GetObjectMessage) {
    const oid = message.objectid
    this.log.info(`Peer requested object ${oid}`)

    const obj = await this.peerManager.objectDB.get(oid)
    if (obj !== null) {
      this.sendMessage({ type: 'object', object: obj })
    }
    else {
      this.sendError('UNKNOWN_OBJECT', `Object ${oid} not found`)
    }
  }
  async handleObject(message: ObjectMessage) {
    const obj = message.object
    const oid = objectId(obj)
    this.log.info(`Received object ${oid}`)

    // Ignore objects already in db
    const exists = await this.peerManager.objectDB.has(oid)
    if (exists) {
      this.log.debug(`Object ${oid} already in database, ignoring`)
      return
    }

    // Parse and validate application object
    let appObj
    try {
      appObj = parseApplicationObject(obj)
    }
    catch (e) {
      this.log.warn(`Object ${oid} has invalid format`)
      this.sendError('INVALID_FORMAT', `Object has invalid format`)
      return
    }

    // Validate based on type
    if (appObj.type === 'transaction') {
      const result = await validateTransaction(appObj as Transaction, this.peerManager.objectDB)
      if (!result.valid) {
        this.log.warn(`Transaction ${oid} validation failed: ${result.error} - ${result.description}`)
        this.sendError(result.error, result.description)
        return
      }
    }
    // here we havent implemented the block validation stay tuned :D
    // so Object is valid and we store it
    await this.peerManager.objectDB.put(obj)
    this.log.info(`Stored valid object ${oid}`)

    // Gossip it
    this.peerManager.broadcast(
      { type: 'ihaveobject', objectid: oid },
      this // exclude the sender
    )
  }
  handleGetMempool(_: GetMempoolMessage) {
    this.log.info(`Peer requested mempool`)
    this.sendMessage({ type: 'mempool', txids: [] })
  }
  handleMempool(message: MempoolMessage) {
    this.log.info(`Peer sent mempool with ${message.txids.length} txids`)
  }
  handleGetChainTip(_: GetChainTipMessage) {
    this.log.info(`Peer requested chain tip`)
    this.sendMessage({
      type: 'chaintip',
      blockid: '00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6'
    })
  }
  handleChainTip(message: ChainTipMessage) {
    this.log.info(`Peer reports chain tip: ${message.blockid}`)
  }

  // Send helpers

  sendHello() {
    const helloMessage: HelloMessage = {
      type: 'hello',
      version: PROTOCOL_VERSION,
      agent: `${conf.AGENT_NAME} ${conf.AGENT_VERSION}`
    }
    this.sendMessage(helloMessage)
  }
  sendGetPeers() {
    const getPeersMessage: GetPeersMessage = {
      type: 'getpeers'
    }
    this.sendMessage(getPeersMessage)
  }
  sendPeers() {
    const peers = this.peerManager.getKnownPeerAddrs()
    this.log.info('Sending our list of known peers')
    const peersMessage: PeersMessage = {
      type: 'peers',
      peers
    }
    this.log.debug({ peers }, 'Our known peers')
    this.sendMessage(peersMessage)
  }
  sendError(name: MarabuError, description: string) {
    const errorMessage: ErrorMessage = {
      type: 'error', name, description
    }
    this.sendMessage(errorMessage)
  }
  protected override error(description: string, name: MarabuError = 'INTERNAL_ERROR') {
    try {
      this.sendError(name, description)
    }
    catch {
      this.log.debug(`Failed to inform peer about "${name}" error: ${description}`)
    }
    super.error(description)
    this.peerManager.removeConnection(this)
  }
}

// Register all handlers 
handlers.set('hello', MarabuPeer.prototype.handleHello)
handlers.set('getpeers', MarabuPeer.prototype.handleGetPeers)
handlers.set('peers', MarabuPeer.prototype.handlePeers)
handlers.set('error', MarabuPeer.prototype.handleError)
handlers.set('ihaveobject', MarabuPeer.prototype.handleIHaveObject)
handlers.set('getobject', MarabuPeer.prototype.handleGetObject)
handlers.set('object', MarabuPeer.prototype.handleObject)
handlers.set('getmempool', MarabuPeer.prototype.handleGetMempool)
handlers.set('mempool', MarabuPeer.prototype.handleMempool)
handlers.set('getchaintip', MarabuPeer.prototype.handleGetChainTip)
handlers.set('chaintip', MarabuPeer.prototype.handleChainTip)

log.debug(`Registered ${handlers.size} handlers`)
