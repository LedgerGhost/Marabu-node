import db from './db'
import { loadHeight } from './utxo'
import { log } from './log'

const CHAINTIP_KEY = 'chaintip'

export interface ChainTip {
  blockid: string
  height: number
}

export async function getChainTip(): Promise<ChainTip | null> {
  const raw = await db.get(CHAINTIP_KEY)
  if (raw === undefined) return null
  try {
    return JSON.parse(raw) as ChainTip
  } catch {
    return null
  }
}

export async function setChainTip(blockid: string, height: number): Promise<void> {
  await db.put(CHAINTIP_KEY, JSON.stringify({ blockid, height }))
  log.info(`Chain tip updated to ${blockid} (height ${height})`)
}

// Update tip if `blockid` is at greater height than current tip.
// Returns true iff the tip was changed.
export async function maybeUpdateChainTip(blockid: string): Promise<boolean> {
  const height = await loadHeight(blockid)
  if (height === null) return false
  const current = await getChainTip()
  if (current === null || height > current.height) {
    await setChainTip(blockid, height)
    return true
  }
  return false
}
