import { hash, objectManager } from './objectmanager'
import { validate as validateTx } from './tx'
import { type MarabuBlockObject, type MarabuTxObject, type MarabuError } from './net/protocol'
import { UTXOSet, loadUTXO } from './utxo'
import { log } from './log'

const REQUIRED_TARGET = '00000000abc00000000000000000000000000000000000000000000000000000'
const GENESIS_BLOCKID = '00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6'
const BLOCK_REWARD = 50_000_000_000_000

export type BlockValidationResult =
  | { valid: true, utxoSet: UTXOSet }
  | { valid: false, error: MarabuError, description: string }

function fail(error: MarabuError, description: string): BlockValidationResult {
  return { valid: false, error, description }
}

function isCoinbase(tx: MarabuTxObject): boolean {
  return tx.height !== undefined && tx.inputs === undefined
}

function satisfiesPoW(blockid: string, target: string): boolean {
  return blockid < target
}

export async function validateBlock(
  block: MarabuBlockObject,
  blockRaw: any
): Promise<BlockValidationResult> {

  const blockid = hash(blockRaw)
  if (blockid === undefined) {
    return fail('INVALID_FORMAT', 'Block is not hashable')
  }

  // Target
  if (block.T !== REQUIRED_TARGET) {
    return fail('INVALID_FORMAT', `Block target must be ${REQUIRED_TARGET}, got ${block.T}`)
  }

  // Genesis
  if (block.previd === null) {
    if (blockid !== GENESIS_BLOCKID) {
      return fail('INVALID_GENESIS', 'Block has null previd but is not the genesis block')
    }
    return { valid: true, utxoSet: new UTXOSet() }
  }

  if (!satisfiesPoW(blockid, block.T)) {
    return fail('INVALID_BLOCK_POW', `Block hash ${blockid} does not satisfy target ${block.T}`)
  }

  // All txids must resolve
  const transactions: { tx: MarabuTxObject, txid: string }[] = []

  for (const txid of block.txids) {
    const obj = await objectManager.get(txid)
    if (obj === undefined) {
      return fail('UNFINDABLE_OBJECT', `Transaction ${txid} not found in database`)
    }
    if (obj.type !== 'transaction') {
      return fail('UNFINDABLE_OBJECT', `Object ${txid} is not a transaction`)
    }
    transactions.push({ tx: obj, txid })
  }

  // Coinbase position
  let coinbaseTx: MarabuTxObject | null = null
  let coinbaseTxid: string | null = null
  let coinbaseCount = 0

  for (let i = 0; i < transactions.length; i++) {
    if (isCoinbase(transactions[i]!.tx)) {
      coinbaseCount++
      if (i !== 0) {
        return fail(
          'INVALID_BLOCK_COINBASE',
          `Coinbase transaction must be at index 0 in txids, found at index ${i}`
        )
      }
      coinbaseTx = transactions[i]!.tx
      coinbaseTxid = transactions[i]!.txid
    }
  }

  if (coinbaseCount > 1) {
    return fail('INVALID_BLOCK_COINBASE', `Block has ${coinbaseCount} coinbase transactions, max 1`)
  }

  // Coinbase format
  if (coinbaseTx !== null) {
    if (coinbaseTx.outputs.length !== 1) {
      return fail('INVALID_FORMAT', `Coinbase must have exactly 1 output, has ${coinbaseTx.outputs.length}`)
    }
    if (coinbaseTx.height === undefined
      || typeof coinbaseTx.height !== 'number'
      || !Number.isInteger(coinbaseTx.height)
      || coinbaseTx.height < 0) {
      return fail('INVALID_FORMAT', `Coinbase has invalid height`)
    }
  }

  // Parent UTXO
  const parentUTXO = await loadUTXO(block.previd)
  if (parentUTXO === null) {
    return fail('UNFINDABLE_OBJECT', `Parent block ${block.previd} UTXO set not available`)
  }

  const utxoSet = parentUTXO.clone()

  // Coinbase not spent in same block
  if (coinbaseTxid !== null) {
    for (const { tx } of transactions) {
      if (isCoinbase(tx)) continue
      if (tx.inputs === undefined) continue
      for (const input of tx.inputs) {
        if (input.outpoint.txid === coinbaseTxid) {
          return fail(
            'INVALID_TX_OUTPOINT',
            'Transaction spends coinbase output from the same block'
          )
        }
      }
    }
  }

  // Validate each tx and build UTXO set
  let totalFees = 0

  for (let i = 0; i < transactions.length; i++) {
    const { tx, txid } = transactions[i]!

    if (isCoinbase(tx)) {
      for (let j = 0; j < tx.outputs.length; j++) {
        utxoSet.add(txid, j, {
          pubkey: tx.outputs[j]!.pubkey,
          value: tx.outputs[j]!.value
        })
      }
      continue
    }

    if (tx.inputs === undefined) {
      return fail('INVALID_FORMAT', `Non-coinbase transaction ${txid} has no inputs`)
    }

    let inputSum = 0
    for (const input of tx.inputs) {
      const utxoEntry = utxoSet.get(input.outpoint.txid, input.outpoint.index)
      if (utxoEntry === undefined) {
        return fail(
          'INVALID_TX_OUTPOINT',
          `Input ${input.outpoint.txid}:${input.outpoint.index} not in UTXO set`
        )
      }
      inputSum += utxoEntry.value
    }

    const [valid, err, desc] = await validateTx(tx)
    if (!valid && err !== undefined && desc !== undefined) {
      return fail(err, desc)
    }

    let outputSum = 0
    for (const output of tx.outputs) {
      outputSum += output.value
    }
    totalFees += (inputSum - outputSum)

    for (const input of tx.inputs) {
      utxoSet.remove(input.outpoint.txid, input.outpoint.index)
    }
    for (let j = 0; j < tx.outputs.length; j++) {
      utxoSet.add(txid, j, {
        pubkey: tx.outputs[j]!.pubkey,
        value: tx.outputs[j]!.value
      })
    }
  }

  // Coinbase conservation
  if (coinbaseTx !== null) {
    const coinbaseOutput = coinbaseTx.outputs[0]!.value
    const maxAllowed = BLOCK_REWARD + totalFees

    if (coinbaseOutput > maxAllowed) {
      return fail(
        'INVALID_BLOCK_COINBASE',
        `Coinbase output ${coinbaseOutput} exceeds max ${maxAllowed} (reward ${BLOCK_REWARD} + fees ${totalFees})`
      )
    }
  }

  log.info(`Block ${blockid} validated (${transactions.length} txs, UTXO: ${utxoSet.size} entries)`)
  return { valid: true, utxoSet }
}

export { REQUIRED_TARGET, GENESIS_BLOCKID, BLOCK_REWARD, satisfiesPoW, isCoinbase }
