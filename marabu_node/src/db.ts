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
    try {
      await this.db.get(key)
      return true
    } catch (e: any) {
      if (e.code === 'LEVEL_NOT_FOUND') return false
      throw e
    }
  }

  async get(key: string): Promise<string | undefined> {
    await this.ensureReady()
    try {
      return await this.db.get(key)
    } catch (e: any) {
      if (e.code === 'LEVEL_NOT_FOUND') return undefined
      throw e
    }
  }

  async put(key: string, value: string): Promise<void> {
    await this.ensureReady()
    await this.db.put(key, value)
  }

  async close(): Promise<void> {
    await this.ensureReady()
    await this.db.close()
  }
}

const db = new Database()
export default db
