import { type MarabuError, type MarabuTxObject } from './net/protocol'
import { type RegularTransaction, isCoinbase } from './objects'
import { getChainTip } from './chain'
import { loadUTXO, UTXOSet } from './utxo'
import { objectManager } from './objectmanager'
import { validateAgainstUTXOSet } from './tx'
import { log } from './log'

type MempoolResult =
  | { valid: true }
  | { valid: false, error: MarabuError, description: string }

const mempoolTxids = new Set<string>()
const candidateTxids = new Set<string>()
const pendingRebuildCandidates = new Set<string>()
let rebuildInFlight: Promise<void> | null = null

function fail(error: MarabuError, description: string): MempoolResult {
  return { valid: false, error, description }
}

export function getMempoolTxids(): string[] {
  return Array.from(mempoolTxids)
}

export async function addTransactionToMempool(
  txid: string,
  tx: MarabuTxObject,
  baseBlockid?: string
): Promise<MempoolResult> {
  if (!isCoinbase(tx)) {
    candidateTxids.add(txid)
  }

  const accepted = Array.from(mempoolTxids).filter(existing => existing !== txid)
  const view = await buildSpendableView(accepted, baseBlockid)
  if (view === null) {
    mempoolTxids.delete(txid)
    return fail('UNKNOWN_OBJECT', 'No current chain tip UTXO is available')
  }

  const result = await applyTransactionToView(txid, tx, view)
  if (result.valid) {
    mempoolTxids.add(txid)
  } else {
    mempoolTxids.delete(txid)
  }
  return result
}

export async function rebuildMempool(extraCandidates: string[] = [], baseBlockid?: string): Promise<void> {
  const resolvedBaseBlockid = baseBlockid ?? (await getChainTip())?.blockid
  if (resolvedBaseBlockid === undefined) {
    mempoolTxids.clear()
    return
  }

  const base = await loadUTXO(resolvedBaseBlockid)
  if (base === null) {
    mempoolTxids.clear()
    return
  }

  const candidates = new Set<string>([
    ...mempoolTxids,
    ...candidateTxids,
    ...extraCandidates
  ])

  const view = base.clone()
  const rebuiltTxids = new Set<string>()

  let remaining = Array.from(candidates)
  let progressed = true

  while (progressed && remaining.length > 0) {
    progressed = false
    const nextRemaining: string[] = []

    for (const txid of remaining) {
      const obj = await objectManager.get(txid)
      if (obj === undefined || obj.type !== 'transaction') continue
      if (isCoinbase(obj)) continue

      const result = await applyTransactionToView(txid, obj, view)
      if (result.valid) {
        rebuiltTxids.add(txid)
        progressed = true
      } else if (result.error === 'INVALID_TX_OUTPOINT') {
        nextRemaining.push(txid)
      } else {
        log.debug(`Dropping ${txid} from mempool candidates: ${result.error} ${result.description}`)
      }
    }

    remaining = nextRemaining
  }

  mempoolTxids.clear()
  for (const txid of rebuiltTxids) {
    mempoolTxids.add(txid)
  }
}

export function requestMempoolRebuild(extraCandidates: string[] = []): Promise<void> {
  for (const txid of extraCandidates) {
    pendingRebuildCandidates.add(txid)
  }

  if (rebuildInFlight !== null) {
    return rebuildInFlight
  }

  rebuildInFlight = (async () => {
    try {
      while (pendingRebuildCandidates.size > 0) {
        const candidates = Array.from(pendingRebuildCandidates)
        pendingRebuildCandidates.clear()
        await rebuildMempool(candidates)
      }
      await rebuildMempool()
    } finally {
      rebuildInFlight = null
      if (pendingRebuildCandidates.size > 0) {
        void requestMempoolRebuild()
      }
    }
  })()

  return rebuildInFlight
}

async function buildSpendableView(txids: string[], baseBlockid?: string): Promise<UTXOSet | null> {
  const resolvedBaseBlockid = baseBlockid ?? (await getChainTip())?.blockid
  if (resolvedBaseBlockid === undefined) return null

  const base = await loadUTXO(resolvedBaseBlockid)
  if (base === null) return null

  const view = base.clone()
  for (const txid of txids) {
    const obj = await objectManager.get(txid)
    if (obj === undefined || obj.type !== 'transaction') continue
    if (isCoinbase(obj)) continue
    const result = await applyTransactionToView(txid, obj, view)
    if (!result.valid) continue
  }

  return view
}

async function applyTransactionToView(
  txid: string,
  tx: MarabuTxObject,
  view: UTXOSet
): Promise<MempoolResult> {
  if (isCoinbase(tx)) {
    return fail('INVALID_TX_OUTPOINT', 'Coinbase transactions are not valid mempool transactions')
  }

  const [valid, err, desc] = await validateAgainstUTXOSet(tx, view)
  if (!valid) {
    return fail(err ?? 'INVALID_FORMAT', desc ?? 'Transaction is invalid')
  }

  const regular = tx as RegularTransaction
  const inputs: { txid: string, index: number }[] = []

  for (const input of regular.inputs) {
    const entry = view.get(input.outpoint.txid, input.outpoint.index)
    if (entry === undefined) {
      return fail('INVALID_TX_OUTPOINT',
        `Input ${input.outpoint.txid}:${input.outpoint.index} is not spendable on the current chain`)
    }
    inputs.push(input.outpoint)
  }

  for (const input of inputs) {
    view.remove(input.txid, input.index)
  }
  for (let index = 0; index < regular.outputs.length; index++) {
    view.add(txid, index, {
      pubkey: regular.outputs[index]!.pubkey,
      value: regular.outputs[index]!.value
    })
  }

  return { valid: true }
}
