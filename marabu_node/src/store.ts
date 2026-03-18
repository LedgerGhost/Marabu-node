import { Level } from 'level'
import { log } from './log'
import { objectId } from './crypto'
import canonicalize from 'canonicalize'

export class ObjectDB {
  private db: Level<string, string>

  constructor(path: string = './objectdb') {
    this.db = new Level(path, { valueEncoding: 'utf8' })
  }

  async open() {
    await this.db.open()
    log.info('Object database opened')
  }

  async close() {
    await this.db.close()
  }

  // Check if object w said objectid already in db.
  async has(oid: string): Promise<boolean> {
    const value = await this.db.get(oid)
    return value !== undefined
  }

  // Retrieve an object by its objectid. Returns null if not found.
  async get(oid: string): Promise<object | null> {
    const json = await this.db.get(oid)
    if (json === undefined) {
      return null
    }
    try {
      return JSON.parse(json)
    }
    catch {
      return null
    }
  }

  // Store. Key is the BLAKE2s hash of its canonical JSON.
  async put(obj: object): Promise<string> {
    const oid = objectId(obj)
    const json = canonicalize(obj)
    if (json === undefined) {
      throw new Error('Failed to canonicalize object for storage')
    }
    await this.db.put(oid, json)
    log.debug(`Stored object ${oid}`)
    return oid
  }
}
