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
  console.error(`Uncaught exception: ${err.message}`)
  console.error(err.stack || '')
  process.exit(1)
})
process.on('unhandledRejection', (reason: any) => {
  console.error(`Unhandled rejection: ${reason?.message || reason}`)
  if (reason?.stack) {
    console.error(reason.stack)
  }
  process.exit(1)
})

run()
