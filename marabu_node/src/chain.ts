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
  const current = await loadStoredChainTip()
  const currentValid = current !== null
    ? await isLocallyValidatedChainAtHeight(current.blockid, current.height)
    : false

  const best = await getBestKnownChainTip(currentValid ? current!.height : -1)
  if (best !== null) {
    await setChainTip(best.blockid, best.height)
    return best
  }

  if (currentValid) return current
  return null
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
  const current = await loadStoredChainTip()
  if (current !== null && current.height >= height) return false
  if (!await isLocallyValidatedChainAtHeight(blockid, height)) return false

  if (current === null || height > current.height) {
    await setChainTip(blockid, height)
    return true
  }
  return false
}

async function loadStoredChainTip(): Promise<ChainTip | null> {
  const raw = await db.get(CHAINTIP_KEY)
  if (raw === undefined) return null
  try {
    const parsed = JSON.parse(raw) as ChainTip
    if (typeof parsed.blockid !== 'string' || typeof parsed.height !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

async function getBestKnownChainTip(minHeightExclusive: number): Promise<ChainTip | null> {
  const heights = await loadAllHeights()
  heights.sort((a, b) => b.height - a.height)

  for (const candidate of heights) {
    if (candidate.height <= minHeightExclusive) return null
    if (!await isLocallyValidatedChainAtHeight(candidate.blockid, candidate.height)) {
      log.warn(`Ignoring invalid chain tip candidate ${candidate.blockid} at height ${candidate.height}`)
      continue
    }
    return candidate
  }
  return null
}

async function isLocallyValidatedChainAtHeight(blockid: string, height: number): Promise<boolean> {
  const seen = new Set<string>()
  let cursor: string | null = blockid
  let expectedHeight = height

  while (cursor !== null) {
    if (seen.has(cursor) || expectedHeight < 0) return false
    seen.add(cursor)

    const storedHeight = await loadHeight(cursor)
    if (storedHeight !== expectedHeight) return false
    const block = await objectManager.get(cursor)
    if (block === undefined || block.type !== 'block') return false
    if (block.previd === null) {
      return cursor === GENESIS_BLOCKID && expectedHeight === 0
    }
    cursor = block.previd
    expectedHeight--
  }

  return false
}
