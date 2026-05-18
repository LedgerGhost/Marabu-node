import { type MarabuError } from './net/protocol'
import {
  type Transaction,
  type RegularTransaction,
  type Output,
  type Outpoint,
  isCoinbase,
  parseApplicationObject
} from './objects'
import { verifySignature } from './crypto'
import { objectManager } from './objectmanager'
import canonicalize from 'canonicalize'
import { type UTXOSet } from './utxo'

type OutpointResolution =
  | { valid: true, output: Output }
  | { valid: false, error: MarabuError, description: string }

type OutpointResolver = (outpoint: Outpoint) => Promise<OutpointResolution>

// Validate a tx object and return [valid, error, description].
export async function validate(
  tx: any
): Promise<[boolean, MarabuError | undefined, string | undefined]> {
  return await validateWithOutpointResolver(tx, async (outpoint) => {
    const refObj = await objectManager.get(outpoint.txid)
    if (refObj === undefined) {
      return {
        valid: false,
        error: 'UNKNOWN_OBJECT',
        description: `Transaction ${outpoint.txid} referenced by outpoint not found`
      }
    }

    if (refObj.type !== 'transaction') {
      return {
        valid: false,
        error: 'INVALID_FORMAT',
        description: `Outpoint references non-transaction object ${outpoint.txid}`
      }
    }

    const refTx = refObj as Transaction
    if (outpoint.index >= refTx.outputs.length) {
      return {
        valid: false,
        error: 'INVALID_TX_OUTPOINT',
        description: `Outpoint index ${outpoint.index} out of range`
      }
    }

    return { valid: true, output: refTx.outputs[outpoint.index]! }
  })
}

export async function validateAgainstUTXOSet(
  tx: any,
  utxoSet: UTXOSet
): Promise<[boolean, MarabuError | undefined, string | undefined]> {
  return await validateWithOutpointResolver(tx, async (outpoint) => {
    const entry = utxoSet.get(outpoint.txid, outpoint.index)
    if (entry === undefined) {
      return {
        valid: false,
        error: 'INVALID_TX_OUTPOINT',
        description: `Input ${outpoint.txid}:${outpoint.index} is not spendable`
      }
    }
    return { valid: true, output: entry }
  })
}

async function validateWithOutpointResolver(
  tx: any,
  resolveOutpoint: OutpointResolver
): Promise<[boolean, MarabuError | undefined, string | undefined]> {
  let parsed: Transaction
  try {
    const obj = parseApplicationObject(tx)
    if (obj.type !== 'transaction') {
      return [false, 'INVALID_FORMAT', 'Object is not a transaction']
    }
    parsed = obj as Transaction
  } catch (e: any) {
    return [false, 'INVALID_FORMAT', `Invalid transaction format: ${e.message}`]
  }

  if (isCoinbase(parsed)) {
    return [true, undefined, undefined]
  }

  const regular = parsed as RegularTransaction

  const seenOutpoints = new Set<string>()
  for (const input of regular.inputs) {
    const key = `${input.outpoint.txid}:${input.outpoint.index}`
    if (seenOutpoints.has(key)) {
      return [false, 'INVALID_TX_OUTPOINT', `Outpoint ${key} is used more than once`]
    }
    seenOutpoints.add(key)
  }

  let inputSum = 0

  for (const input of regular.inputs) {
    const { outpoint, sig } = input

    const resolved = await resolveOutpoint(outpoint)
    if (!resolved.valid) {
      return [false, resolved.error, resolved.description]
    }

    // Verify signature
    if (sig === null) {
      return [false, 'INVALID_TX_SIGNATURE', `Null signature for input ${outpoint.txid}:${outpoint.index}`]
    }

    const txForSigning = {
      ...regular,
      inputs: regular.inputs.map(inp => ({
        outpoint: inp.outpoint,
        sig: null
      }))
    }
    const signingMessage = canonicalize(txForSigning)
    if (signingMessage === undefined) {
      return [false, 'INVALID_FORMAT', 'Failed to canonicalize transaction for signing']
    }

    if (!verifySignature(sig, signingMessage, resolved.output.pubkey)) {
      return [false, 'INVALID_TX_SIGNATURE', `Invalid signature for input ${outpoint.txid}:${outpoint.index}`]
    }

    inputSum += resolved.output.value
  }

  // Conservation law
  let outputSum = 0
  for (const output of regular.outputs) {
    outputSum += output.value
  }

  if (inputSum < outputSum) {
    return [false, 'INVALID_TX_CONSERVATION', `Conservation violated: inputs ${inputSum} < outputs ${outputSum}`]
  }

  return [true, undefined, undefined]
}
