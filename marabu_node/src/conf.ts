import * as z from 'zod'

const Hex32Regex = /^[0-9a-f]{64}$/
const AsciiPrintable128Regex = /^[\x20-\x7e]{0,128}$/

function parseBooleanEnv(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function parseCsvEnv(value: string): string[] {
  return value
    .split(',')
    .map(v => v.trim())
    .filter(v => v.length > 0)
}

const ConfigSchema = z.object({
  SERVER_HOST: z.string().default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().default(18018),
  AGENT_NAME: z.string().trim().max(128).default('LedgerGhost'),
  AGENT_VERSION: z.string().default('1.0.0'),
  AGENT_AUTHOR: z.string().default('Konstantinos Stergiou'),

  IP_RETRIEVAL_SERVICE: z.url({ protocol: /^https$/ }).default('https://ifconfig.me/ip'),
  TARGET_NUM_CONNECTIONS: z.coerce.number().default(8),

  PEERS_FILE: z.string().default('peers.json'),
  BOOTSTRAP_PEERS: z.string()
    .default('95.179.158.137:18018,95.179.132.22:18018,45.32.235.245:18018')
    .transform(s => s ? s.split(',') : []),
  MAX_PEERS_PER_NEIGHBOUR: z.coerce.number().default(8),

  LOG_LEVEL: z.string().default('debug'),

  MINING_ENABLED: z.string().default('false').transform(parseBooleanEnv),
  MINER_STUDENT_IDS: z.string()
    .default('')
    .transform(parseCsvEnv)
    .refine(ids => ids.length <= 10, 'MINER_STUDENT_IDS must contain at most 10 ids')
    .refine(
      ids => ids.every(id => AsciiPrintable128Regex.test(id)),
      'MINER_STUDENT_IDS entries must be ASCII-printable strings up to 128 characters'
    ),
  MINER_REWARD_PUBKEY: z.string()
    .default('')
    .refine(v => v === '' || Hex32Regex.test(v), 'MINER_REWARD_PUBKEY must be a 64-char lowercase hex public key'),
  MINER_NOTE: z.string()
    .default('')
    .refine(v => v === '' || AsciiPrintable128Regex.test(v), 'MINER_NOTE must be ASCII-printable and at most 128 characters'),
  MINER_MINE_EMPTY_BLOCKS: z.string().default('false').transform(parseBooleanEnv),
  MINER_WORKERS: z.coerce.number().int().nonnegative().default(0),
  MINER_BATCH_SIZE: z.coerce.number().int().positive().default(5000),
  MINER_TEMPLATE_REFRESH_MS: z.coerce.number().int().positive().default(15000),
  MINER_STATUS_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  MINER_NONCE_HEX_CHARS: z.coerce.number().int().min(16).max(128).default(64)
})

export default ConfigSchema.parse(process.env)
