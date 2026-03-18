import pino from 'pino'
import conf from './conf'

export const log = pino({
  level: conf.LOG_LEVEL,
  transport: {
    target: 'pino-pretty'
  }
})