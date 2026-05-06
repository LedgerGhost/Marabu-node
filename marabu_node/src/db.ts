import { Level } from 'level'
import { log } from './log'

const DB_PATH = './objectdb'

class Database {
  private db: Level<string, string>
  private ready: Promise<void>

  constructor(path: string = DB_PATH) {
    this.db = new Level(path, { valueEncoding: 'utf8' })
    this.ready = this.db.open().then(() => {
      log.info('Database opened')
    })
  }

  private async ensureReady() {
    await this.ready
  }

  async has(key: string): Promise<boolean> {
    await this.ensureReady()
    // Level 10: get returns undefined for missing keys (it no longer throws LEVEL_NOT_FOUND).
    const v = await this.db.get(key).catch((e: any) => {
      if (e?.code === 'LEVEL_NOT_FOUND') return undefined
      throw e
    })
    return v !== undefined
  }

  async get(key: string): Promise<string | undefined> {
    await this.ensureReady()
    return await this.db.get(key).catch((e: any) => {
      if (e?.code === 'LEVEL_NOT_FOUND') return undefined
      throw e
    })
  }

  async del(key: string): Promise<void> {
    await this.ensureReady()
    await this.db.del(key)
  }

  async put(key: string, value: string): Promise<void> {
    await this.ensureReady()
    await this.db.put(key, value)
  }

  async keys(gte: string, lt: string): Promise<string[]> {
    await this.ensureReady()
    const keys: string[] = []
    for await (const key of this.db.keys({ gte, lt })) {
      keys.push(key)
    }
    return keys
  }

  async close(): Promise<void> {
    await this.ensureReady()
    await this.db.close()
  }
}

const db = new Database()
export default db
