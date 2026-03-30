import { log } from './log'
import conf from './conf'
import chalk from 'chalk'
import { run } from './net/serve'
import * as semver from 'semver'

log.info(`🌊 ${chalk.blue(`${conf.AGENT_NAME} ${conf.AGENT_VERSION}`)}`)
log.info(`${conf.AGENT_AUTHOR}`)

if (typeof globalThis.Bun !== 'undefined') {
  if (!semver.satisfies(Bun.version, '>=1.3.10')) {
    throw new Error(`Stage 3 decorators require Bun >=1.3.10, got ${Bun.version}`)
  }
}

process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err.message}`)
  log.error(err.stack || '')
})
process.on('unhandledRejection', (reason: any) => {
  log.error(`Unhandled rejection: ${reason?.message || reason}`)
})

run()