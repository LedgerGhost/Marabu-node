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
const HEIGHT_PREFIX = 'height:'

export async function saveUTXO(blockid: string, utxoSet: UTXOSet): Promise<void> {
  await db.put(UTXO_PREFIX + blockid, JSON.stringify(utxoSet.serialize()))
  log.debug(`Saved UTXO set for block ${blockid} (${utxoSet.size} entries)`)
}

export async function loadUTXO(blockid: string): Promise<UTXOSet | null> {
  const raw = await db.get(UTXO_PREFIX + blockid)
  if (raw === undefined) return null
  return UTXOSet.deserialize(JSON.parse(raw) as Record<string, UTXOEntry>)
}

export async function hasUTXO(blockid: string): Promise<boolean> {
  return await db.has(UTXO_PREFIX + blockid)
}

export async function saveHeight(blockid: string, height: number): Promise<void> {
  await db.put(HEIGHT_PREFIX + blockid, String(height))
}

export async function loadHeight(blockid: string): Promise<number | null> {
  const raw = await db.get(HEIGHT_PREFIX + blockid)
  if (raw === undefined) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

export async function hasHeight(blockid: string): Promise<boolean> {
  return await db.has(HEIGHT_PREFIX + blockid)
}
