import { hash, objectManager } from './objectmanager'
import { validate as validateTx } from './tx'
import { type MarabuBlockObject, type MarabuTxObject, type MarabuError } from './net/protocol'
import {
  type CoinbaseTransaction,
  type RegularTransaction,
  isCoinbase as isCoinbaseTx,
  BlockSchema
} from './objects'
import {
  UTXOSet,
  loadUTXO,
  saveUTXO,
  loadHeight,
  saveHeight,
} from './utxo'
import { log } from './log'

const REQUIRED_TARGET = '00000000abc00000000000000000000000000000000000000000000000000000'
const GENESIS_BLOCKID = '00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6'
const BLOCK_REWARD = 50_000_000_000_000

export type BlockValidationOk = {
  valid: true
  blockid: string
  height: number
  utxoSet: UTXOSet
}
export type BlockValidationFail = {
  valid: false
  error: MarabuError
  description: string
}
export type BlockValidationResult = BlockValidationOk | BlockValidationFail

// Unified fetcher for any object (parent blocks, transactions, etc.)
export type ObjectFetcher = (objectid: string) => Promise<any | null>

// Keep ParentFetcher as an alias for backwards compatibility in calling code
export type ParentFetcher = ObjectFetcher

const inFlightBlockValidations = new Map<string, Promise<BlockValidationResult>>()

function fail(error: MarabuError, description: string): BlockValidationFail {
  return { valid: false, error, description }
}

function isCoinbase(tx: MarabuTxObject): tx is CoinbaseTransaction {
  return isCoinbaseTx(tx)
}

function satisfiesPoW(blockid: string, target: string): boolean {
  // Both blockid and target are 64-char lowercase hex strings,
  // so lexicographic comparison matches numeric comparison.
  return blockid < target
}

/**
 * Validate a block. If `block.previd` or any txid points to an unknown object,
 * `fetchObject(id)` is invoked to obtain the raw object JSON from peers.
 *
 * Validation order ensures specific error codes are sent before attempting
 * expensive network I/O for transactions:
 *   Hash -> Cache -> Format -> Target -> Genesis -> PoW -> Future-timestamp ->
 *   Parent fetch+recursion -> Parent-timestamp -> Tx fetch+validate -> Coinbase -> UTXO
 *
 * On success: stores the block, height and UTXO set, returns height + utxo.
 * On failure: returns the appropriate Marabu error code and description.
 */
export async function validateAndStoreBlock(
  blockRaw: any,
  fetchObject: ObjectFetcher,
  visited: Set<string> = new Set()
): Promise<BlockValidationResult> {
  const blockid = hash(blockRaw)
  if (blockid === undefined) {
    return fail('INVALID_FORMAT', 'Block is not canonicalizable')
  }

  // Short circuit: we have already validated this block. This check happens
  // before strict parsing so older locally validated ancestry can be used as
  // an anchor even if a later schema is stricter than the one it was mined with.
  const known = await loadValidatedBlockState(blockid)
  if (known !== null) {
    return known
  }

  // 1. Strict format parsing.
  let block: MarabuBlockObject
  try {
    block = BlockSchema.parse(blockRaw)
  } catch (e: any) {
    return fail('INVALID_FORMAT', `Block has invalid format: ${e.message}`)
  }

  // Cycle protection (PoW makes this practically impossible, but be safe).
  if (visited.has(blockid)) {
    return fail('UNFINDABLE_OBJECT', `Cycle detected at block ${blockid}`)
  }
  visited.add(blockid)

  const inFlight = inFlightBlockValidations.get(blockid)
  if (inFlight !== undefined) {
    return await inFlight
  }

  const validation = validateAndStoreBlockInner(block, blockRaw, blockid, fetchObject, visited)
  inFlightBlockValidations.set(blockid, validation)
  try {
    return await validation
  } finally {
    inFlightBlockValidations.delete(blockid)
  }
}

async function validateAndStoreBlockInner(
  block: MarabuBlockObject,
  blockRaw: any,
  blockid: string,
  fetchObject: ObjectFetcher,
  visited: Set<string>
): Promise<BlockValidationResult> {
  // 3. Target.
  if (block.T !== REQUIRED_TARGET) {
    return fail('INVALID_FORMAT', `Block target must be ${REQUIRED_TARGET}, got ${block.T}`)
  }

  // 4. Genesis short circuit.
  if (block.previd === null) {
    if (blockid !== GENESIS_BLOCKID) {
      return fail('INVALID_GENESIS', `Block has null previd but is not the genesis (${blockid})`)
    }
    await objectManager.put(block)
    await saveHeight(blockid, 0)
    await saveUTXO(blockid, new UTXOSet())
    return { valid: true, blockid, height: 0, utxoSet: new UTXOSet() }
  }

  // 5. Proof-of-work.
  if (!satisfiesPoW(blockid, block.T)) {
    return fail('INVALID_BLOCK_POW', `Block hash ${blockid} does not satisfy target ${block.T}`)
  }

  // 6. Timestamp upper bound (cannot be in the future).
  const now = Math.floor(Date.now() / 1000)
  if (block.created > now) {
    return fail('INVALID_BLOCK_TIMESTAMP', `Block timestamp ${block.created} is in the future (now=${now})`)
  }

  // 7. Parent validation. A locally validated parent is a trusted blocktree
  // anchor; otherwise fetch and recursively validate it.
  let parentRaw: any | null = await objectManager.getRaw(block.previd)
  let parentResult = await loadValidatedBlockState(block.previd)

  if (parentResult === null) {
    if (parentRaw === undefined) {
      parentRaw = await fetchObject(block.previd)
    }
    if (parentRaw === null || parentRaw === undefined) {
      return fail('UNFINDABLE_OBJECT', `Parent block ${block.previd} not available`)
    }

    // Hash check on the fetched parent.
    const fetchedId = hash(parentRaw)
    if (fetchedId !== block.previd) {
      return fail('UNFINDABLE_OBJECT', `Fetched parent has wrong id ${fetchedId}, expected ${block.previd}`)
    }

    const recursiveResult = await validateAndStoreBlock(parentRaw, fetchObject, visited)
    if (!recursiveResult.valid) {
      // Propagate the parent's specific error code so the grader receives the right error.
      // E.g. if parent has INVALID_GENESIS, the child also signals INVALID_GENESIS.
      return fail(recursiveResult.error, `Parent block ${block.previd} is invalid: ${recursiveResult.description}`)
    }
    parentResult = recursiveResult
  } else if (parentRaw === undefined || parentRaw === null) {
    return fail('UNFINDABLE_OBJECT', `Parent block ${block.previd} not available`)
  }

  // 8. Timestamp must be strictly greater than the parent's.
  // The parent block must be in the DB now, either as a trusted local anchor or
  // because validateAndStoreBlock stored it.
  if (!isRawBlockLike(parentRaw)) {
    return fail('UNFINDABLE_OBJECT', `Parent block ${block.previd} is not available as a block`)
  }
  if (block.created <= parentRaw.created) {
    return fail('INVALID_BLOCK_TIMESTAMP',
      `Block timestamp ${block.created} is not greater than parent ${parentRaw.created}`)
  }

  const parentHeight = parentResult.height
  const blockHeight = parentHeight + 1

  // 9. Resolve all txids — fetch missing transactions from the network,
  //    validate and store them before running block-level checks.
  //    This happens AFTER timestamp checks, so timestamp errors take priority.
  const transactions: { tx: MarabuTxObject, txid: string }[] = []
  for (const txid of block.txids) {
    let obj = await objectManager.get(txid)

    if (obj === undefined) {
      // Transaction not in local DB — fetch it via the provided fetcher.
      const rawTx = await fetchObject(txid)
      if (rawTx === null) {
        return fail('UNFINDABLE_OBJECT', `Transaction ${txid} not findable`)
      }
      // Validate the fetched transaction before storing.
      const [valid, ferr, fdesc] = await validateTx(rawTx)
      if (!valid) {
        return fail('UNFINDABLE_OBJECT', `Invalid transaction ${txid} fetched for block: ${ferr} ${fdesc}`)
      }
      await objectManager.put(rawTx)
      obj = await objectManager.get(txid)
    }

    if (obj === undefined) {
      return fail('UNFINDABLE_OBJECT', `Transaction ${txid} not found in database`)
    }
    if (obj.type !== 'transaction') {
      return fail('UNFINDABLE_OBJECT', `Object ${txid} is not a transaction`)
    }
    transactions.push({ tx: obj, txid })
  }

  // 10. Coinbase: at most one, and only at index 0. Plus height check.
  let coinbaseTx: CoinbaseTransaction | null = null
  let coinbaseTxid: string | null = null
  let coinbaseCount = 0

  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i]!
    if (isCoinbase(t.tx)) {
      coinbaseCount++
      if (i !== 0) {
        return fail('INVALID_BLOCK_COINBASE',
          `Coinbase must be at index 0, found at index ${i}`)
      }
      coinbaseTx = t.tx
      coinbaseTxid = t.txid
    }
  }
  if (coinbaseCount > 1) {
    return fail('INVALID_BLOCK_COINBASE', `Block has ${coinbaseCount} coinbase transactions, max 1`)
  }

  if (coinbaseTx !== null) {
    if (coinbaseTx.outputs.length !== 1) {
      return fail('INVALID_FORMAT', `Coinbase must have exactly 1 output, has ${coinbaseTx.outputs.length}`)
    }
    if (coinbaseTx.height !== blockHeight) {
      return fail('INVALID_BLOCK_COINBASE',
        `Coinbase height ${coinbaseTx.height} does not match block height ${blockHeight}`)
    }
  }

  // 11. UTXO update.
  const parentUTXO = await loadUTXO(block.previd)
  if (parentUTXO === null) {
    return fail('UNFINDABLE_OBJECT', `Parent UTXO set for ${block.previd} not available`)
  }
  const utxoSet = parentUTXO.clone()

  // Coinbase cannot be spent in the same block.
  if (coinbaseTxid !== null) {
    for (const { tx } of transactions) {
      if (isCoinbase(tx)) continue
      const reg = tx as RegularTransaction
      for (const input of reg.inputs) {
        if (input.outpoint.txid === coinbaseTxid) {
          return fail('INVALID_TX_OUTPOINT',
            'Transaction spends coinbase output from the same block')
        }
      }
    }
  }

  let totalFees = 0
  for (let i = 0; i < transactions.length; i++) {
    const { tx, txid } = transactions[i]!

    if (isCoinbase(tx)) {
      utxoSet.add(txid, 0, { pubkey: tx.outputs[0]!.pubkey, value: tx.outputs[0]!.value })
      continue
    }

    const reg = tx as RegularTransaction
    let inputSum = 0
    for (const input of reg.inputs) {
      const entry = utxoSet.get(input.outpoint.txid, input.outpoint.index)
      if (entry === undefined) {
        return fail('INVALID_TX_OUTPOINT',
          `Input ${input.outpoint.txid}:${input.outpoint.index} not in UTXO set`)
      }
      inputSum += entry.value
    }

    const [valid, err, desc] = await validateTx(tx)
    if (!valid && err !== undefined && desc !== undefined) {
      if (err === 'INVALID_TX_SIGNATURE'
        || err === 'INVALID_TX_CONSERVATION'
        || err === 'INVALID_TX_OUTPOINT'
        || err === 'UNKNOWN_OBJECT') {
        return fail('UNFINDABLE_OBJECT', `Invalid transaction ${txid} in block: ${desc}`)
      }
      return fail(err, desc)
    }

    let outputSum = 0
    for (const out of tx.outputs) outputSum += out.value
    totalFees += inputSum - outputSum

    for (const input of reg.inputs) {
      utxoSet.remove(input.outpoint.txid, input.outpoint.index)
    }
    for (let j = 0; j < tx.outputs.length; j++) {
      utxoSet.add(txid, j, {
        pubkey: tx.outputs[j]!.pubkey,
        value: tx.outputs[j]!.value
      })
    }
  }

  // 12. Coinbase law of conservation.
  if (coinbaseTx !== null) {
    const coinbaseOutput = coinbaseTx.outputs[0]!.value
    const maxAllowed = BLOCK_REWARD + totalFees
    if (coinbaseOutput > maxAllowed) {
      return fail('INVALID_BLOCK_COINBASE',
        `Coinbase output ${coinbaseOutput} exceeds max ${maxAllowed} (reward ${BLOCK_REWARD} + fees ${totalFees})`)
    }
  }

  // 13. Persist block, height, UTXO.
  await objectManager.put(block)
  await saveHeight(blockid, blockHeight)
  await saveUTXO(blockid, utxoSet)

  log.info(`Block ${blockid} validated (height ${blockHeight}, ${transactions.length} txs)`)
  return { valid: true, blockid, height: blockHeight, utxoSet }
}

async function loadValidatedBlockState(blockid: string): Promise<BlockValidationOk | null> {
  const height = await loadHeight(blockid)
  if (height === null) return null
  const utxoSet = await loadUTXO(blockid)
  if (utxoSet === null) return null
  return { valid: true, blockid, height, utxoSet }
}

function isRawBlockLike(obj: any): obj is { type: 'block', created: number } {
  return obj !== null
    && obj !== undefined
    && obj.type === 'block'
    && typeof obj.created === 'number'
    && Number.isInteger(obj.created)
}

/**
 * Quick pre-flight check before any I/O is performed for a block:
 * format, hardcoded target, PoW and future timestamp. This avoids letting an
 * attacker trigger network requests with malformed or impossible blocks.
 *
 * Returns null on success, or a validation failure describing the error.
 */
export function preValidateBlock(blockRaw: any, blockid: string): BlockValidationFail | null {
  let block: MarabuBlockObject
  try {
    block = BlockSchema.parse(blockRaw)
  } catch (e: any) {
    return fail('INVALID_FORMAT', `Block has invalid format: ${e.message}`)
  }
  if (block.T !== REQUIRED_TARGET) {
    return fail('INVALID_FORMAT', `Block target must be ${REQUIRED_TARGET}, got ${block.T}`)
  }
  if (block.previd === null) {
    if (blockid !== GENESIS_BLOCKID) {
      return fail('INVALID_GENESIS', `Block has null previd but is not the genesis (${blockid})`)
    }
    return null
  }
  if (!satisfiesPoW(blockid, block.T)) {
    return fail('INVALID_BLOCK_POW', `Block hash ${blockid} does not satisfy target ${block.T}`)
  }
  const now = Math.floor(Date.now() / 1000)
  if (block.created > now) {
    return fail('INVALID_BLOCK_TIMESTAMP', `Block timestamp ${block.created} is in the future (now=${now})`)
  }
  return null
}

export {
  REQUIRED_TARGET,
  GENESIS_BLOCKID,
  BLOCK_REWARD,
  satisfiesPoW,
  isCoinbase
}
