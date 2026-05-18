import db from './db'
import { loadAllHeights, loadHeight, loadUTXO } from './utxo'
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
    ? await isLocallyValidatedBlockAtHeight(current.blockid, current.height)
    : false

  if (currentValid) return current

  const best = await getBestKnownChainTip(-1)
  if (best === null) return null
  await setChainTip(best.blockid, best.height)
  return best
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
  if (!await isLocallyValidatedBlockAtHeight(blockid, height)) return false

  if (current === null || height > current.height) {
    await setChainTip(blockid, height)
    return true
  }
  return false
}

export async function getDisconnectedTxids(oldTip: string | null, newTip: string): Promise<string[]> {
  if (oldTip === null || oldTip === newTip) return []

  let oldCursor: string | null = oldTip
  let newCursor: string | null = newTip
  let oldHeight = await loadHeight(oldCursor)
  let newHeight = await loadHeight(newCursor)
  if (oldHeight === null || newHeight === null) return []

  const disconnectedTipFirst: string[] = []

  while (oldCursor !== null && oldHeight > newHeight) {
    const info = await loadStoredBlockInfo(oldCursor)
    if (info === null) return disconnectedTipFirst.reverse()
    disconnectedTipFirst.push(...info.txids)
    oldCursor = info.previd
    oldHeight--
  }

  while (newCursor !== null && newHeight > oldHeight) {
    const info = await loadStoredBlockInfo(newCursor)
    if (info === null) return disconnectedTipFirst.reverse()
    newCursor = info.previd
    newHeight--
  }

  while (oldCursor !== null && newCursor !== null && oldCursor !== newCursor) {
    const oldInfo = await loadStoredBlockInfo(oldCursor)
    const newInfo = await loadStoredBlockInfo(newCursor)
    if (oldInfo === null || newInfo === null) return disconnectedTipFirst.reverse()
    disconnectedTipFirst.push(...oldInfo.txids)
    oldCursor = oldInfo.previd
    newCursor = newInfo.previd
    oldHeight--
    newHeight--
  }

  return disconnectedTipFirst.reverse()
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
    if (!await isLocallyValidatedBlockAtHeight(candidate.blockid, candidate.height)) {
      log.warn(`Ignoring invalid chain tip candidate ${candidate.blockid} at height ${candidate.height}`)
      continue
    }
    return candidate
  }
  return null
}

async function isLocallyValidatedBlockAtHeight(blockid: string, height: number): Promise<boolean> {
  return await loadHeight(blockid) === height
    && await loadUTXO(blockid) !== null
    && await loadStoredBlockInfo(blockid) !== null
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
    if (await loadUTXO(cursor) === null) return false
    const block = await loadStoredBlockInfo(cursor)
    if (block === null) return false
    if (block.previd === null) {
      return cursor === GENESIS_BLOCKID && expectedHeight === 0
    }
    cursor = block.previd
    expectedHeight--
  }

  return false
}

async function loadStoredBlockInfo(blockid: string): Promise<{ previd: string | null, txids: string[] } | null> {
  const raw = await objectManager.getRaw(blockid)
  if (raw === undefined || raw === null || raw.type !== 'block') return null
  if (raw.previd !== null && typeof raw.previd !== 'string') return null
  if (!Array.isArray(raw.txids)) return null
  const txids = raw.txids.filter((txid: unknown): txid is string => typeof txid === 'string')
  return { previd: raw.previd, txids }
}
