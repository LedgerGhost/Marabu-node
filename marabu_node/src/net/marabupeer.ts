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
  type MarabuError,
  type MarabuObject,
  type MarabuBlockObject,
  type MarabuTxObject,
  MarabuObjectSchema
} from './protocol'
import * as z from 'zod'
import * as semver from 'semver'
import { Socket } from 'net'
import type { PeerManager } from './peermanager'
import { log } from '../log'
import canonicalize from 'canonicalize'
import { hash, validateObject, objectManager } from '../objectmanager'
import { validateBlock, isCoinbase } from '../block'
import { saveUTXO } from '../utxo'

const PROTOCOL_VERSION = '0.10.0'
const PROTOCOL_COMPATIBLE_VERSIONS = '0.10.x'

type MessageHandler<T> = (this: MarabuPeer, message: T) => Promise<void>
// holds a list of methods that handle protocol messages,
// one for each message type, for dispatching purposes
const handlers = new Map<Message["type"], MessageHandler<Message>>()

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
    // handle internal socket errors by closing the connection and without informing peer
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
  }
  protected override onNetworkMessage(message: any) {
    let parsedMessage: Message | undefined

    try {
      parsedMessage = MessageSchema.parse(message)
    }
    catch (e: any) {
      if (e instanceof z.ZodError) {
        const tree = z.treeifyError<Message>(e as z.ZodError<Message>)
        if (tree.properties?.type?.errors?.includes('Invalid input')) {
          // we don't understand this message type... yet
          this.onParseError(`Unrecognized message type`)
          return
        }
      }
      this.onParseError(`Error "${e.message}" when parsing protocol message: ${canonicalize(message)}`)
      return
    }
    this.log.debug(`Parsed protocol message`)

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
      return this.error(`No registered handler to handle message ${message}`)
    }
    this.log.debug(`Using handler ${handler} for message`)
    try {
      await handler.call(this, message)
    }
    catch (e: any) {
      this.log.warn(`Handler failed to handle message ${message}`)
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
    this.log.info(`Peer requested our peers`)
    this.sendPeers()
  }
  @handle('peers')
  async handlePeers(message: PeersMessage) {
    this.log.info(`Peer reported known peers: ${message.peers}`)
    const peersToStore: string[] = message.peers.slice(0, conf.MAX_PEERS_PER_NEIGHBOUR)
    this.peerManager.addKnownPeers(peersToStore)
  }
  @handle('error')
  async handleError(message: ErrorMessage) {
    // log remote error and disconnect
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
    let obj: MarabuObject | undefined

    this.log.debug('Retrieving object from database')
    obj = await objectManager.get(message.objectid)
    this.log.debug('Retrieved object from database')

    if (obj === undefined) {
      this.sendError('UNFINDABLE_OBJECT', `Object with id ${message.objectid} not found`)
      return
    }
    this.sendObject(obj)
  }
  @handle('object')
  async handleObject(message: ObjectMessage) {
    const objectid = hash(message.object)

    if (objectid === undefined) {
      this.log.warn(`Received unexpected unhashable object ${message.object}`)
      return
    }

    this.peerManager.notifyObjectWaiters(objectid, message.object)

    if (await objectManager.has(objectid)) {
      this.log.info(`Received already known object ${objectid}`)
      return
    }

    if (message.object.type === 'block') {
      await this.handleBlockObject(message.object as MarabuBlockObject, objectid)
    }
    else {
      await this.handleTransactionObject(message.object as MarabuTxObject, objectid)
    }
  }
  private async handleTransactionObject(tx: MarabuTxObject, objectid: string) {
    const [_, err, desc] = await validateObject(tx)

    if (err !== undefined && desc !== undefined) {
      this.sendError(err, desc)
      return
    }
    await objectManager.put(tx)

    // broadcast
    for (let peer of this.peerManager.connections) {
      if (peer !== this) {
        peer.sendIHaveObject(objectid)
      }
    }
  }
  private async handleBlockObject(block: MarabuBlockObject, blockid: string) {
    this.log.info(`Processing block ${blockid} (${block.txids.length} txs)`)

    for (const txid of block.txids) {
      if (await objectManager.has(txid)) continue

      this.log.info(`Block references unknown tx ${txid}, fetching from peers...`)
      const fetched = await this.requestObjectFromPeers(txid)

      if (fetched === null) {
        this.sendError('UNFINDABLE_OBJECT', `Cannot find transaction ${txid}`)
        return
      }

      let parsed: MarabuObject
      try {
        parsed = MarabuObjectSchema.parse(fetched)
      } catch (e) {
        this.sendError('UNFINDABLE_OBJECT', `Fetched object ${txid} has invalid format`)
        return
      }
      if (parsed.type !== 'transaction') {
        this.sendError('UNFINDABLE_OBJECT', `Object ${txid} is not a transaction`)
        return
      }

      await objectManager.put(fetched)
      this.log.info(`Stored fetched transaction ${txid}`)
    }

    const result = await validateBlock(block, block)

    if (!result.valid) {
      this.log.warn(`Block ${blockid} invalid: [${result.error}] ${result.description}`)
      this.sendError(result.error, result.description)
      return
    }

    await objectManager.put(block)
    await saveUTXO(blockid, result.utxoSet)
    this.log.info(`Stored valid block ${blockid} (UTXO: ${result.utxoSet.size} entries)`)

    for (let peer of this.peerManager.connections) {
      if (peer !== this) {
        peer.sendIHaveObject(blockid)
      }
    }
  }
  private async requestObjectFromPeers(objectid: string, timeoutMs: number = 5000): Promise<any | null> {
    return new Promise((resolve) => {
      let resolved = false

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.peerManager.removeObjectWaiter(objectid)
          resolve(null)
        }
      }, timeoutMs)

      this.peerManager.registerObjectWaiter(objectid, (_oid: string, obj: any) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          resolve(obj)
        }
      })

      for (let peer of this.peerManager.connections) {
        peer.sendGetObject(objectid)
      }
    })
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
  sendIHaveObject(objectid: string) {
    const iHaveObjectMessage: IHaveObjectMessage = {
      type: 'ihaveobject',
      objectid
    }
    this.sendMessage(iHaveObjectMessage)
  }
  sendGetObject(objectid: string) {
    const getObjectMessage: GetObjectMessage = {
      type: 'getobject',
      objectid
    }
    this.sendMessage(getObjectMessage)
  }
  sendObject(object: MarabuObject) {
    const objectMessage: ObjectMessage = {
      type: 'object',
      object
    }
    this.sendMessage(objectMessage)
  }
  sendError(name: MarabuError, description: string) {
    const errorMessage: ErrorMessage = {
      type: 'error', name, description
    }
    this.sendMessage(errorMessage)
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

// Decorator used for dispatching
function handle<K extends Message["type"]>(type: K) {
  return function (handler: MessageHandler<Extract<Message, { type: K }>>) {
    log.debug(`Registering handler ${handler.name} for messages of type ${type}`)
    handlers.set(type, handler as MessageHandler<Message>)
  }
}

log.debug(`Registered ${handlers.size} handlers`)