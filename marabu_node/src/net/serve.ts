import { createServer } from 'net'
import { MarabuPeer } from './marabupeer'
import conf from '../conf'
import { log } from '../log'
import { PeerManager } from './peermanager'
import { hash, objectManager } from '../objectmanager'
import { UTXOSet, saveUTXO, hasUTXO, saveHeight, hasHeight } from '../utxo'
import { getChainTip, setChainTip } from '../chain'

const GENESIS_BLOCK = {
  T: '00000000abc00000000000000000000000000000000000000000000000000000',
  created: 1771159355,
  miner: 'Marabu',
  nonce: '00dd82159556175752d9ba7349df67bddd237b59183747383f7b720e85c32347',
  note: "Financial Times 2026-02-13: Crypto's battle with the banks is splitting Trump's base",
  previd: null,
  txids: [],
  type: 'block'
}
const GENESIS_BLOCKID = '00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6'

export async function run() {
  const genesisId = hash(GENESIS_BLOCK)
  if (genesisId !== GENESIS_BLOCKID) {
    throw new Error(`Genesis hash mismatch! Got ${genesisId}, expected ${GENESIS_BLOCKID}`)
  }
  log.info(`Genesis block hash verified: ${genesisId}`)

  if (!await objectManager.has(GENESIS_BLOCKID)) {
    await objectManager.put(GENESIS_BLOCK)
    log.info('Stored genesis block in object database')
  }
  if (!await hasUTXO(GENESIS_BLOCKID)) {
    await saveUTXO(GENESIS_BLOCKID, new UTXOSet())
    log.info('Initialized empty UTXO set for genesis block')
  }
  if (!await hasHeight(GENESIS_BLOCKID)) {
    await saveHeight(GENESIS_BLOCKID, 0)
    log.info('Initialized genesis block height to 0')
  }
  if ((await getChainTip()) === null) {
    await setChainTip(GENESIS_BLOCKID, 0)
  }

  let myPublicIP: string | undefined
  try {
    const resp = await fetch(conf.IP_RETRIEVAL_SERVICE)
    myPublicIP = await resp.text()
    log.info(`Discovered self public IP: ${myPublicIP}`)
  } catch (e: any) {
    log.warn(`Failed to discover public IP: ${e.message}. Using 0.0.0.0`)
    myPublicIP = '0.0.0.0'
  }

  const peerManager = new PeerManager(myPublicIP)
  await peerManager.restore()

  const server = createServer(socket => {
    new MarabuPeer(socket, peerManager)
  })
  server.listen(conf.SERVER_PORT, conf.SERVER_HOST)
  log.info(`Listening for connections on ${conf.SERVER_HOST}:${conf.SERVER_PORT}`)

  await peerManager.connectSufficiently()
}
