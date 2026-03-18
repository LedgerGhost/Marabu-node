import { Socket } from 'net'
import { log } from '../log'
import assert from 'node:assert'
import canonicalize from 'canonicalize'

// Generic network Peer class for any protocol that uses
// TCP with newline-delimited JSON messages.
// Handles basic logic such as defragmentation.
export abstract class Peer {
  socket
  log

  protected abstract onNetworkMessage(message: any): void
  protected abstract onParseError(description: string): void

  protected error(description: string) {
    this.log.error(description)
    this.socket.end()
  }
  private onRawNetworkMessage(networkMessage: string) {
    let message

    this.log.debug(`Received network message: ${networkMessage}`)

    try {
      message = JSON.parse(networkMessage)
    }
    catch (e) {
      return this.onParseError(`Invalid JSON message: ${networkMessage}`)
    }
    this.log.debug(`Parsed JSON message`)
    this.onNetworkMessage(message)
  }
  sendMessage(message: object) {
    const networkMessage = canonicalize(message)

    if (networkMessage === undefined) {
      return this.error(`Failed to JSON serialize message ${message}`)
    }
    this.socket.write(`${networkMessage}\n`)
  }
  constructor(socket: Socket) {
    let remoteAddr

    if (socket.readyState === 'open') {
      remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`
    }
    else {
      remoteAddr = `(unknown)`
      socket.on('connect', () => {
        remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`
        this.log = log.child({ peer: remoteAddr })
      })
    }

    this.log = log.child({ peer: remoteAddr })
    this.log.info(`New connection`)

    let buffer: string = ''

    socket.on('data', data => {
      buffer += data

      // Defragment
      const lines = buffer.split('\n')

      assert(lines.length >= 1)
      while (lines.length > 1) {
        const networkMessage = lines.shift()!
        this.onRawNetworkMessage(networkMessage)
      }
      assert(lines.length == 1)

      buffer = lines[0]!
    })

    this.socket = socket
  }
}