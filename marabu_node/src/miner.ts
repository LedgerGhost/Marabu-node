import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import canonicalize from 'canonicalize'
import conf from './conf'
import { log } from './log'
import { hash, objectManager } from './objectmanager'
import {
  BLOCK_REWARD,
  REQUIRED_TARGET,
  satisfiesPoW,
  validateAndStoreBlock
} from './block'
import { getChainTip, maybeUpdateChainTip } from './chain'
import { getMempoolTxids, requestMempoolRebuild } from './mempool'
import type { MarabuBlockObject, MarabuObject } from './net/protocol'
import type { CoinbaseTransaction } from './objects'
import type { PeerManager } from './net/peermanager'

const NONCE_PLACEHOLDER = '0123456789abcdeffedcba9876543210'
const IDLE_RETRY_MS = 5000
const requireFromMiner = createRequire(import.meta.url)
const BLAKE2_MODULE_PATH = requireFromMiner.resolve('@noble/hashes/blake2.js')

type MiningJob = {
  block: MarabuBlockObject
  prefix: string
  suffix: string
  coinbaseTx: CoinbaseTransaction | null
  parentBlockid: string
  height: number
  txCount: number
}

type MineOutcome =
  | { type: 'found', nonce: string, blockid: string, hashes: number, elapsedMs: number }
  | { type: 'refresh', hashes: number, elapsedMs: number }
  | { type: 'failed', hashes: number, elapsedMs: number }

type MineFinish =
  | { type: 'found', nonce: string, blockid: string }
  | { type: 'refresh' }
  | { type: 'failed' }

type WorkerStatus = {
  type: 'status'
  hashes: number
}

type WorkerFound = {
  type: 'found'
  nonce: string
  blockid: string
  hashes: number
}

type WorkerMessage = WorkerStatus | WorkerFound

export function startMiner(peerManager: PeerManager): void {
  if (!conf.MINING_ENABLED) {
    log.info('Mining disabled. Set MINING_ENABLED=true to start mining blocks.')
    return
  }

  if (conf.MINER_STUDENT_IDS.length === 0) {
    log.error('Mining enabled but MINER_STUDENT_IDS is empty; refusing to mine non-scoring pset6 blocks.')
    return
  }

  const miner = new Miner(peerManager)
  void miner.run()
}

class Miner {
  private readonly workerCount: number

  constructor(private readonly peerManager: PeerManager) {
    this.workerCount = conf.MINER_WORKERS > 0
      ? conf.MINER_WORKERS
      : Math.max(1, cpus().length - 1)
  }

  async run(): Promise<void> {
    log.info(`Mining enabled with ${this.workerCount} worker(s); studentids=${conf.MINER_STUDENT_IDS.join(',')}`)

    while (true) {
      try {
        const job = await buildMiningJob()
        if (job === null) {
          await sleep(IDLE_RETRY_MS)
          continue
        }

        log.info(`Mining block at height ${job.height} on ${job.parentBlockid} with ${job.txCount} mempool tx(s)`)
        const outcome = await this.mine(job)
        const hashrate = outcome.elapsedMs > 0
          ? Math.round(outcome.hashes / (outcome.elapsedMs / 1000))
          : 0

        if (outcome.type === 'found') {
          log.info(`Found block candidate ${outcome.blockid} after ${outcome.hashes} hashes (${hashrate} H/s)`)
          await this.acceptFoundBlock(job, outcome)
        } else if (outcome.type === 'refresh') {
          log.info(`Refreshing mining template after ${outcome.hashes} hashes (${hashrate} H/s)`)
        } else {
          log.warn(`Mining workers stopped before finding a block after ${outcome.hashes} hashes`)
          await sleep(IDLE_RETRY_MS)
        }
      } catch (e: any) {
        log.warn(`Miner loop failed: ${e?.message ?? e}`)
        if (e?.stack) log.debug(e.stack)
        await sleep(IDLE_RETRY_MS)
      }
    }
  }

  private mine(job: MiningJob): Promise<MineOutcome> {
    const workers: Worker[] = []
    const workerTotals = new Map<Worker, number>()
    const started = Date.now()
    const modulo = 1n << BigInt(conf.MINER_NONCE_HEX_CHARS * 4)
    const randomStart = BigInt(`0x${randomBytes(Math.ceil(conf.MINER_NONCE_HEX_CHARS / 2)).toString('hex')}`) % modulo

    return new Promise<MineOutcome>((resolve) => {
      let settled = false

      const totalHashes = () => {
        let total = 0
        for (const n of workerTotals.values()) total += n
        return total
      }

      const finish = (outcome: MineFinish) => {
        if (settled) return
        settled = true
        clearTimeout(refreshTimer)
        for (const worker of workers) {
          void worker.terminate()
        }
        resolve({
          ...outcome,
          hashes: totalHashes(),
          elapsedMs: Date.now() - started
        } as MineOutcome)
      }

      const refreshTimer = setTimeout(() => {
        finish({ type: 'refresh' })
      }, conf.MINER_TEMPLATE_REFRESH_MS)

      for (let i = 0; i < this.workerCount; i++) {
        const worker = new Worker(MINER_WORKER_CODE, {
          eval: true,
          workerData: {
            prefix: job.prefix,
            suffix: job.suffix,
            target: REQUIRED_TARGET,
            blake2ModulePath: BLAKE2_MODULE_PATH,
            start: ((randomStart + BigInt(i)) % modulo).toString(),
            stride: this.workerCount.toString(),
            nonceWidth: conf.MINER_NONCE_HEX_CHARS,
            batchSize: conf.MINER_BATCH_SIZE,
            reportIntervalMs: conf.MINER_STATUS_INTERVAL_MS
          }
        })

        workers.push(worker)
        workerTotals.set(worker, 0)

        worker.on('message', (message: WorkerMessage) => {
          workerTotals.set(worker, message.hashes)
          if (message.type === 'found') {
            finish({ type: 'found', nonce: message.nonce, blockid: message.blockid })
          }
        })

        worker.on('error', (err: Error) => {
          log.warn(`Mining worker failed: ${err.message}`)
          workerTotals.delete(worker)
          if (!settled && workerTotals.size === 0) {
            finish({ type: 'failed' })
          }
        })

        worker.on('exit', (code) => {
          if (!settled && code !== 0) {
            log.warn(`Mining worker exited with code ${code}`)
          }
        })
      }
    })
  }

  private async acceptFoundBlock(job: MiningJob, outcome: Extract<MineOutcome, { type: 'found' }>): Promise<void> {
    const block: MarabuBlockObject = { ...job.block, nonce: outcome.nonce }
    const blockid = hash(block)

    if (blockid === undefined || blockid !== outcome.blockid || !satisfiesPoW(blockid, REQUIRED_TARGET)) {
      log.warn(`Discarding inconsistent mined block result ${outcome.blockid}`)
      return
    }

    const currentTip = await getChainTip()
    if (currentTip !== null && currentTip.blockid !== job.parentBlockid) {
      log.info(`Mined block extends ${job.parentBlockid}, but current tip is now ${currentTip.blockid}; validating anyway`)
    }

    if (job.coinbaseTx !== null) {
      await objectManager.put(job.coinbaseTx)
    }

    const result = await validateAndStoreBlock(block, async (objectid: string): Promise<MarabuObject | null> => {
      return await objectManager.get(objectid) ?? null
    })

    if (!result.valid) {
      log.warn(`Mined block ${blockid} failed validation: ${result.error} ${result.description}`)
      return
    }

    const becameTip = await maybeUpdateChainTip(result.blockid)
    await requestMempoolRebuild(block.txids)
    this.peerManager.broadcastIHaveObject(result.blockid)

    log.info(`Mined block ${result.blockid} accepted at height ${result.height}${becameTip ? ' and is the new chain tip' : ''}`)
  }
}

async function buildMiningJob(): Promise<MiningJob | null> {
  const tip = await getChainTip()
  if (tip === null) {
    log.warn('Cannot mine without a chain tip')
    return null
  }

  await requestMempoolRebuild()
  const mempoolTxids = getMempoolTxids()
  if (mempoolTxids.length === 0 && !conf.MINER_MINE_EMPTY_BLOCKS) {
    log.info('Mempool is empty; waiting for transactions before mining')
    return null
  }

  const parent = await objectManager.getRaw(tip.blockid)
  if (!isBlockLike(parent)) {
    log.warn(`Cannot mine on missing or invalid parent ${tip.blockid}`)
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  if (parent.created >= now) {
    log.warn(`Cannot mine yet: parent timestamp ${parent.created} is not before now ${now}`)
    return null
  }

  const height = tip.height + 1
  const txids = [...mempoolTxids]
  let coinbaseTx: CoinbaseTransaction | null = null

  if (conf.MINER_REWARD_PUBKEY !== '') {
    coinbaseTx = {
      type: 'transaction',
      height,
      outputs: [{ pubkey: conf.MINER_REWARD_PUBKEY, value: BLOCK_REWARD }]
    }
    const coinbaseTxid = hash(coinbaseTx)
    if (coinbaseTxid === undefined) {
      throw new Error('Failed to hash miner coinbase transaction')
    }
    txids.unshift(coinbaseTxid)
  }

  const block: MarabuBlockObject = {
    type: 'block',
    txids,
    nonce: NONCE_PLACEHOLDER,
    previd: tip.blockid,
    created: now,
    T: REQUIRED_TARGET,
    miner: conf.AGENT_NAME,
    studentids: conf.MINER_STUDENT_IDS
  }

  if (conf.MINER_NOTE !== '') {
    block.note = conf.MINER_NOTE
  }

  const serialized = canonicalize(block)
  if (serialized === undefined) {
    throw new Error('Failed to canonicalize mining template')
  }

  const split = serialized.split(NONCE_PLACEHOLDER)
  if (split.length !== 2 || split[0] === undefined || split[1] === undefined) {
    throw new Error('Failed to locate nonce placeholder in mining template')
  }

  return {
    block,
    prefix: split[0],
    suffix: split[1],
    coinbaseTx,
    parentBlockid: tip.blockid,
    height,
    txCount: mempoolTxids.length
  }
}

function isBlockLike(obj: any): obj is MarabuBlockObject {
  return obj !== null
    && obj !== undefined
    && obj.type === 'block'
    && typeof obj.created === 'number'
    && Number.isInteger(obj.created)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const MINER_WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads')
const { blake2s } = require(workerData.blake2ModulePath)

const prefix = Buffer.from(workerData.prefix, 'utf8')
const suffix = Buffer.from(workerData.suffix, 'utf8')
const target = Buffer.from(workerData.target, 'hex')
const nonceWidth = workerData.nonceWidth
const nonceStart = prefix.length
const nonceEnd = nonceStart + nonceWidth
const message = Buffer.alloc(prefix.length + nonceWidth + suffix.length)

prefix.copy(message, 0)
suffix.copy(message, nonceEnd)

let counter = BigInt(workerData.start)
const stride = BigInt(workerData.stride)
const modulo = 1n << BigInt(nonceWidth * 4)
const batchSize = workerData.batchSize
const reportIntervalMs = workerData.reportIntervalMs
let hashes = 0
let nextReport = Date.now() + reportIntervalMs

function belowTarget(digest) {
  for (let i = 0; i < target.length; i++) {
    const a = digest[i]
    const b = target[i]
    if (a < b) return true
    if (a > b) return false
  }
  return false
}

while (true) {
  for (let i = 0; i < batchSize; i++) {
    const nonce = counter.toString(16).padStart(nonceWidth, '0')
    message.write(nonce, nonceStart, nonceWidth, 'ascii')

    const digest = blake2s(message)
    hashes++

    if (belowTarget(digest)) {
      parentPort.postMessage({
        type: 'found',
        nonce,
        blockid: Buffer.from(digest).toString('hex'),
        hashes
      })
      process.exit(0)
    }

    counter = (counter + stride) % modulo
  }

  const now = Date.now()
  if (now >= nextReport) {
    parentPort.postMessage({ type: 'status', hashes })
    nextReport = now + reportIntervalMs
  }
}
`
