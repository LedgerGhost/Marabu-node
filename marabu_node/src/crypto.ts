import { blake2s } from '@noble/hashes/blake2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import canonicalize from 'canonicalize'

// compute the objectid (BLAKE2s hash) of object.
// object-> canonical JSON-> bytes -> hash.
export function objectId(obj: object): string {
  const json = canonicalize(obj)
  if (json === undefined) {
    throw new Error('Failed to canonicalize object')
  }
  const bytes = new TextEncoder().encode(json)
  const hash = blake2s(bytes)
  return bytesToHex(hash)
}

// verify ed25519 signature
export function verifySignature(
  sigHex: string,
  messageStr: string,
  pubkeyHex: string
): boolean {
  try {
    const sig = hexToBytes(sigHex)
    const pubkey = hexToBytes(pubkeyHex)
    const message = new TextEncoder().encode(messageStr)
    return ed25519.verify(sig, message, pubkey)
  }
  catch {
    return false
  }
}

export { bytesToHex, hexToBytes }
