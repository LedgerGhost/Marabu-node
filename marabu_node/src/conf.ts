import * as z from 'zod'

const ConfigSchema = z.object({
  SERVER_HOST: z.string().default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().default(18018),
  AGENT_NAME: z.string().trim().max(128).default('LedgerGhost(pset3)'),
  AGENT_VERSION: z.string().default('1.0.0'),
  AGENT_AUTHOR: z.string().default('Stergiou Konstantinos <kstergiou987@gmail.com>'),

  IP_RETRIEVAL_SERVICE: z.url({ protocol: /^https$/ }).default('https://ifconfig.me/ip'),
  TARGET_NUM_CONNECTIONS: z.coerce.number().default(8),

  PEERS_FILE: z.string().default('peers.json'),
  BOOTSTRAP_PEERS: z.string()
    .default('95.179.158.137:18018,95.179.132.22:18018,45.32.235.245:18018')
    .transform(s => s ? s.split(',') : []),
  MAX_PEERS_PER_NEIGHBOUR: z.coerce.number().default(8),

  LOG_LEVEL: z.string().default('debug')
})

export default ConfigSchema.parse(process.env)