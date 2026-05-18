import * as z from 'zod'

// A 32-byte hex string 64 hex chars
const Hex32 = z.string().regex(/^[0-9a-f]{64}$/)
const HexString = z.string().regex(/^[0-9a-f]+$/)
// A 64-byte hex string 128 hex chars for Ed25519 
const Hex64 = z.string().regex(/^[0-9a-f]{128}$/)

const OutputSchema = z.strictObject({
  pubkey: Hex32,
  value: z.number().int().nonnegative()
})
export type Output = z.infer<typeof OutputSchema>

const OutpointSchema = z.strictObject({
  txid: Hex32,
  index: z.number().int().nonnegative()
})
export type Outpoint = z.infer<typeof OutpointSchema>

const InputSchema = z.strictObject({
  outpoint: OutpointSchema,
  sig: z.union([Hex64, z.null()])
})
export type Input = z.infer<typeof InputSchema>

// Common tx
export const RegularTransactionSchema = z.strictObject({
  type: z.literal('transaction'),
  inputs: z.array(InputSchema).min(1),
  outputs: z.array(OutputSchema)
})
export type RegularTransaction = z.infer<typeof RegularTransactionSchema>

// Coinbase tx
export const CoinbaseTransactionSchema = z.strictObject({
  type: z.literal('transaction'),
  height: z.number().int().nonnegative(),
  outputs: z.array(OutputSchema)
})
export type CoinbaseTransaction = z.infer<typeof CoinbaseTransactionSchema>

export type Transaction = RegularTransaction | CoinbaseTransaction

// tx is either coinbase or regular
export const TransactionSchema = z.union([
  CoinbaseTransactionSchema,
  RegularTransactionSchema
])

// Ascii-printable string up to 128 chars
const AsciiPrintable128 = z.string().max(128).regex(/^[\x20-\x7e]*$/)

export const BlockSchema = z.strictObject({
  type: z.literal('block'),
  txids: z.array(Hex32),
  nonce: HexString,
  previd: z.union([Hex32, z.null()]),
  created: z.number().int().nonnegative(),
  T: Hex32,
  miner: AsciiPrintable128.optional(),
  note: z.union([AsciiPrintable128, z.null()]).optional(),
  studentids: z.array(AsciiPrintable128).max(10).optional()
})
export type Block = z.infer<typeof BlockSchema>

// Union of all application object types
// We use z.union here because transaction subtypes share the same 'type' field.
export const ApplicationObjectSchema = z.union([
  BlockSchema,
  TransactionSchema
])
export type ApplicationObject = z.infer<typeof ApplicationObjectSchema>

export function isCoinbase(tx: Transaction): tx is CoinbaseTransaction {
  return 'height' in tx && !('inputs' in tx)
}

// Try to parse a raw object as a valid application object.
// Returns parsed object or ZodError.
export function parseApplicationObject(obj: any): ApplicationObject {
  return ApplicationObjectSchema.parse(obj)
}
