import db from './db'
import { log } from './log'

export interface UTXOEntry {
  pubkey: string
  value: number
}

export type OutpointKey = string

export function outpointKey(txid: string, index: number): OutpointKey {
  return `${txid}:${index}`
}

export class UTXOSet {
  private utxos: Map<OutpointKey, UTXOEntry>

  constructor(entries?: Map<OutpointKey, UTXOEntry>) {
    this.utxos = entries ?? new Map()
  }

  clone(): UTXOSet {
    const copy = new Map<OutpointKey, UTXOEntry>()
    for (const [k, v] of this.utxos) {
      copy.set(k, { ...v })
    }
    return new UTXOSet(copy)
  }

  has(txid: string, index: number): boolean {
    return this.utxos.has(outpointKey(txid, index))
  }

  get(txid: string, index: number): UTXOEntry | undefined {
    return this.utxos.get(outpointKey(txid, index))
  }

  add(txid: string, index: number, entry: UTXOEntry): void {
    this.utxos.set(outpointKey(txid, index), entry)
  }

  remove(txid: string, index: number): boolean {
    return this.utxos.delete(outpointKey(txid, index))
  }

  get size(): number {
    return this.utxos.size
  }

  serialize(): Record<string, UTXOEntry> {
    const obj: Record<string, UTXOEntry> = {}
    for (const [k, v] of this.utxos) {
      obj[k] = v
    }
    return obj
  }

  static deserialize(obj: Record<string, UTXOEntry>): UTXOSet {
    const map = new Map<OutpointKey, UTXOEntry>()
    for (const [k, v] of Object.entries(obj)) {
      map.set(k, v)
    }
    return new UTXOSet(map)
  }
}

const UTXO_PREFIX = 'utxo:'

export async function saveUTXO(blockid: string, utxoSet: UTXOSet): Promise<void> {
  await db.put(UTXO_PREFIX + blockid, JSON.stringify(utxoSet.serialize()))
  log.debug(`Saved UTXO set for block ${blockid} (${utxoSet.size} entries)`)
}

export async function loadUTXO(blockid: string): Promise<UTXOSet | null> {
  try {
    const raw = await db.get(UTXO_PREFIX + blockid)
    return UTXOSet.deserialize(JSON.parse(raw as string) as Record<string, UTXOEntry>)
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return null
    throw e
  }
}

export async function hasUTXO(blockid: string): Promise<boolean> {
  try {
    await db.get(UTXO_PREFIX + blockid)
    return true
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return false
    throw e
  }
}