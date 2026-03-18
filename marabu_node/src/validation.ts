import {
  type Transaction,
  type RegularTransaction,
  type Output,
  isCoinbase,
  parseApplicationObject
} from './objects'
import { objectId, verifySignature } from './crypto'
import type { ObjectDB } from './store'
import type { MarabuError } from './net/protocol'
import canonicalize from 'canonicalize'
import { log } from './log'

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: MarabuError; description: string }

function fail(error: MarabuError, description: string): ValidationResult {
  return { valid: false, error, description }
}

function ok(): ValidationResult {
  return { valid: true }
}

// Coinbase transactions are considered always valid. here we are checking
export async function validateTransaction(
  tx: Transaction,
  db: ObjectDB
): Promise<ValidationResult> {
  if (isCoinbase(tx)) {
    return ok()
  }
  return validateRegularTransaction(tx, db)
}

// Validation logic: Validate outpoints exist, verify signatures and check conservation law
async function validateRegularTransaction(
  tx: RegularTransaction,
  db: ObjectDB
): Promise<ValidationResult> {
  let inputSum = 0

  for (const input of tx.inputs) {
    const { outpoint, sig } = input

    // 1. Look up the referenced transaction
    const refObj = await db.get(outpoint.txid)
    if (refObj === null) {
      return fail('UNKNOWN_OBJECT', `Transaction ${outpoint.txid} referenced by outpoint not found in database`)
    }

    // Validate that the referenced object is actually a transaction
    let refTx: Transaction
    try {
      const parsed = parseApplicationObject(refObj)
      if (parsed.type !== 'transaction') {
        return fail('INVALID_FORMAT', `Outpoint references object ${outpoint.txid} which is not a transaction`)
      }
      refTx = parsed as Transaction
    }
    catch {
      return fail('INVALID_FORMAT', `Outpoint references object ${outpoint.txid} which is not a valid transaction`)
    }

    // 2. Validate outpoint index
    if (outpoint.index >= refTx.outputs.length) {
      return fail('INVALID_TX_OUTPOINT', `Outpoint index ${outpoint.index} is out of range (transaction ${outpoint.txid} has ${refTx.outputs.length} outputs)`)
    }

    const referencedOutput: Output = refTx.outputs[outpoint.index]!

    // 3. Verify signature
    if (sig === null) {
      return fail('INVALID_TX_SIGNATURE', `Signature is null for input referencing ${outpoint.txid}:${outpoint.index}`)
    }

    // create signing plaintext: the transaction with all sigs set to null
    const txForSigning = {
      ...tx,
      inputs: tx.inputs.map(inp => ({
        outpoint: inp.outpoint,
        sig: null
      }))
    }
    const signingMessage = canonicalize(txForSigning)
    if (signingMessage === undefined) {
      return fail('INVALID_FORMAT', 'Failed to canonicalize transaction for signature verification')
    }

    const pubkey = referencedOutput.pubkey
    const sigValid = verifySignature(sig, signingMessage, pubkey)
    if (!sigValid) {
      return fail('INVALID_TX_SIGNATURE', `Invalid signature for input referencing ${outpoint.txid}:${outpoint.index}`)
    }

    // Get input value
    inputSum += referencedOutput.value
  }

  // 4. Check conservation law: sum of inputs >= sum of outputs
  let outputSum = 0
  for (const output of tx.outputs) {
    outputSum += output.value
  }

  if (inputSum < outputSum) {
    return fail(
      'INVALID_TX_CONSERVATION',
      `Transaction violates conservation: input sum ${inputSum} < output sum ${outputSum}`
    )
  }

  return ok()
}
