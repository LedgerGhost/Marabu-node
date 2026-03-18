import * as z from 'zod'
import { log } from '../log'
import { isV4, isV6, isPrivateIP, storeIP } from 'range_check'
import dns from 'dns'

export type Addr = [string, number] // [host, port]

// Validate and parse a peer address from "host:port" into [host, port]
export async function parseAddr(peerAddr: string): Promise<Addr> {
  const addrParts = peerAddr.split(':')

  if (addrParts.length < 2) {
    throw new Error(`Address "${peerAddr}" has no port`)
  }

  let host: string = addrParts.slice(0, -1).join(':')
  let port: number = parseInt(addrParts[addrParts.length - 1]!, 10)

  if (isNaN(port) || port<= 0 || port > 65535) {
    throw new Error(`Address "${peerAddr}" has invalid port`)
  }
  if (host.length < 2) {
    throw new Error(`Address "${peerAddr}" host is too short`)
  }

  if (isV4(host)) {
    log.debug(`Host "${host}" is a valid IPv4`)
    host = storeIP(host)
  }
  else {
    if (host[0] === '[' && host[host.length - 1] === ']') {
      const ipv6 = host.slice(1, -1)
      if (isV6(ipv6)) {
        log.debug(`Host "${host}" is a valid IPv6`)
        host = ipv6
        host = storeIP(host)
      }
      else {
        throw new Error(`Invalid IPv6 "${ipv6}"`)
      }
    }
    else {
      try {
        z.hostname().parse(host)
        log.debug(`Host "${host}" is a valid hostname`)
        try {
          const lookup = await dns.promises.lookup(host)
          host = storeIP(lookup.address)
        }
        catch (e) {
          throw new Error(`Could not resolve "${host}"`)
        }
      }
      catch (eHost) {
        throw new Error(`Address "${peerAddr}" has invalid host`)
      }
    }
  }
  if (host === null) {
    throw new Error(`Failed to canonicalize address "${peerAddr}" for storage`)
  }
  return [host, port]
}

export async function isPrivateAddr(addr: string): Promise<boolean> {
  const { address } = await dns.promises.lookup(addr)

  return isPrivateIP(address)
}