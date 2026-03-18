import * as z from 'zod'

const ErrorSchema = z.enum([
  'INTERNAL_ERROR',
  'INVALID_FORMAT',
  'UNKNOWN_OBJECT',
  'UNFINDABLE_OBJECT',
  'INVALID_HANDSHAKE',
  'INVALID_TX_OUTPOINT',
  'INVALID_TX_SIGNATURE',
  'INVALID_TX_CONSERVATION',
  'INVALID_BLOCK_COINBASE',
  'INVALID_BLOCK_TIMESTAMP',
  'INVALID_BLOCK_POW',
  'INVALID_GENESIS'
])
export const ErrorMessageSchema = z.strictObject({
  type: z.literal('error'),
  name: ErrorSchema,
  description: z.string()
})
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>
export type MarabuError = z.infer<typeof ErrorSchema>
export const HelloMessageSchema = z.strictObject({
  type: z.literal('hello'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  agent: z.string().optional()
})
export type HelloMessage = z.infer<typeof HelloMessageSchema>

export const GetPeersMessageSchema = z.strictObject({
  type: z.literal('getpeers')
})
export type GetPeersMessage = z.infer<typeof GetPeersMessageSchema>

export const PeersMessageSchema = z.strictObject({
  type: z.literal('peers'),
  peers: z.array(z.string())
})
export type PeersMessage = z.infer<typeof PeersMessageSchema>

// PSET2 message schemas

const Hex32 = z.string().regex(/^[0-9a-f]{64}$/)

export const GetObjectMessageSchema = z.strictObject({
  type: z.literal('getobject'),
  objectid: Hex32
})
export type GetObjectMessage = z.infer<typeof GetObjectMessageSchema>

export const IHaveObjectMessageSchema = z.strictObject({
  type: z.literal('ihaveobject'),
  objectid: Hex32
})
export type IHaveObjectMessage = z.infer<typeof IHaveObjectMessageSchema>

// The object msg contains an arbitrary object.
// We validate the inner object structure separately in the handler.
export const ObjectMessageSchema = z.strictObject({
  type: z.literal('object'),
  object: z.record(z.string(), z.any())
})
export type ObjectMessage = z.infer<typeof ObjectMessageSchema>

export const GetMempoolMessageSchema = z.strictObject({
  type: z.literal('getmempool')
})
export type GetMempoolMessage = z.infer<typeof GetMempoolMessageSchema>

export const MempoolMessageSchema = z.strictObject({
  type: z.literal('mempool'),
  txids: z.array(Hex32)
})
export type MempoolMessage = z.infer<typeof MempoolMessageSchema>

export const GetChainTipMessageSchema = z.strictObject({
  type: z.literal('getchaintip')
})
export type GetChainTipMessage = z.infer<typeof GetChainTipMessageSchema>

export const ChainTipMessageSchema = z.strictObject({
  type: z.literal('chaintip'),
  blockid: Hex32
})
export type ChainTipMessage = z.infer<typeof ChainTipMessageSchema>

const MessageSchemas = [
  ErrorMessageSchema,
  HelloMessageSchema,
  GetPeersMessageSchema,
  PeersMessageSchema,
  GetObjectMessageSchema,
  IHaveObjectMessageSchema,
  ObjectMessageSchema,
  GetMempoolMessageSchema,
  MempoolMessageSchema,
  GetChainTipMessageSchema,
  ChainTipMessageSchema
] as const

export const MessageSchema = z.discriminatedUnion('type', MessageSchemas)
export type Message = z.infer<typeof MessageSchema>