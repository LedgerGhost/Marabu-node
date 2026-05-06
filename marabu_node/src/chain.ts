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
  const currentHeight = current !== null
    ? await getLocallyValidatedChainHeight(current.blockid)
    : null

  const best = await getBestKnownChainTip()
  if (best === null) {
    if (current !== null && currentHeight !== null) {
      if (current.height !== currentHeight) {
        await setChainTip(current.blockid, currentHeight)
      }
      return { blockid: current.blockid, height: currentHeight }
    }
    return null
  }

  if (current === null
    || currentHeight === null
    || best.height > currentHeight
  ) {
    await setChainTip(best.blockid, best.height)
    return best
  }

  if (current.height !== currentHeight) {
    await setChainTip(current.blockid, currentHeight)
  }
  return { blockid: current.blockid, height: currentHeight }
}

export async function setChainTip(blockid: string, height: number): Promise<void> {
  await db.put(CHAINTIP_KEY, JSON.stringify({ blockid, height }))
  log.info(`Chain tip updated to ${blockid} (height ${height})`)
}

// Update tip if `blockid` is at greater height than current tip.
// Returns true iff the tip was changed.
export async function maybeUpdateChainTip(blockid: string): Promise<boolean> {
  const height = await getLocallyValidatedChainHeight(blockid)
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
  let best: ChainTip | null = null

  for (const candidate of heights) {
    const height = await getLocallyValidatedChainHeight(candidate.blockid)
    if (height === null) continue
    if (candidate.height !== height) {
      log.warn(`Ignoring height metadata mismatch for ${candidate.blockid}: saved=${candidate.height}, actual=${height}`)
      continue
    }
    if (best === null || height > best.height) {
      best = { blockid: candidate.blockid, height }
    }
  }
  return best
}

async function getLocallyValidatedChainHeight(blockid: string): Promise<number | null> {
  const seen = new Set<string>()
  let cursor: string | null = blockid
  const chain: string[] = []

  while (cursor !== null) {
    if (seen.has(cursor)) return null
    seen.add(cursor)
    chain.push(cursor)

    const block = await objectManager.get(cursor)
    if (block === undefined || block.type !== 'block') return null
    if (block.previd === null) {
      if (cursor !== GENESIS_BLOCKID) return null
      const tipHeight = chain.length - 1
      for (let i = 0; i < chain.length; i++) {
        const storedHeight = await loadHeight(chain[i]!)
        const expectedHeight = tipHeight - i
        if (storedHeight !== expectedHeight) return null
      }
      return tipHeight
    }
    cursor = block.previd
  }

  return null
}
