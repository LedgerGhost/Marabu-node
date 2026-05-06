import db from './db'
import { loadAllHeights, loadHeight } from './utxo'
import { log } from './log'
import { objectManager } from './objectmanager'
import { GENESIS_BLOCKID } from './block'

const CHAINTIP_KEY = 'chaintip'

export interface ChainTip {
  blockid: string
  height: number
}

export async function getChainTip(): Promise<ChainTip | null> {
  const raw = await db.get(CHAINTIP_KEY)
  let current: ChainTip | null = null
  if (raw !== undefined) {
    try {
      current = JSON.parse(raw) as ChainTip
    } catch {
      current = null
    }
  }

  const best = await getBestKnownChainTip()
  if (best === null) return current

  if (current === null
    || best.height > current.height
    || !await isLocallyReachableChain(current.blockid)) {
    await setChainTip(best.blockid, best.height)
    return best
  }

  return current
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

async function getBestKnownChainTip(): Promise<ChainTip | null> {
  const heights = await loadAllHeights()
  heights.sort((a, b) => b.height - a.height)

  for (const candidate of heights) {
    if (await isLocallyReachableChain(candidate.blockid)) {
      return candidate
    }
  }
  return null
}

async function isLocallyReachableChain(blockid: string): Promise<boolean> {
  const seen = new Set<string>()
  let cursor: string | null = blockid

  while (cursor !== null) {
    if (seen.has(cursor)) return false
    seen.add(cursor)

    const block = await objectManager.get(cursor)
    if (block === undefined || block.type !== 'block') return false
    if (block.previd === null) return cursor === GENESIS_BLOCKID
    cursor = block.previd
  }

  return false
}
