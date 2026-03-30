import { type MarabuError } from './net/protocol'
import {
  type Transaction,
  type RegularTransaction,
  isCoinbase,
  parseApplicationObject
} from './objects'
import { verifySignature } from './crypto'
import { objectManager } from './objectmanager'
import canonicalize from 'canonicalize'
import { log } from './log'

/**
 * Validate a transaction object.
 * Returns [valid, error, description].
 */
export async function validate(
  tx: any
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

  let inputSum = 0

  for (const input of regular.inputs) {
    const { outpoint, sig } = input

    // Look up referenced transaction
    const refObj = await objectManager.get(outpoint.txid)
    if (refObj === undefined) {
      return [false, 'UNKNOWN_OBJECT', `Transaction ${outpoint.txid} referenced by outpoint not found`]
    }

    if (refObj.type !== 'transaction') {
      return [false, 'INVALID_FORMAT', `Outpoint references non-transaction object ${outpoint.txid}`]
    }

    const refTx = refObj as Transaction

    // Validate outpoint index
    if (outpoint.index >= refTx.outputs.length) {
      return [false, 'INVALID_TX_OUTPOINT', `Outpoint index ${outpoint.index} out of range`]
    }

    const referencedOutput = refTx.outputs[outpoint.index]!

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

    if (!verifySignature(sig, signingMessage, referencedOutput.pubkey)) {
      return [false, 'INVALID_TX_SIGNATURE', `Invalid signature for input ${outpoint.txid}:${outpoint.index}`]
    }

    inputSum += referencedOutput.value
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
