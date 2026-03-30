import { blake2s } from '@noble/hashes/blake2.js'
import canonicalize from 'canonicalize'
import { type MarabuObject, MarabuObjectSchema, type MarabuError } from './net/protocol'
import db from './db'
import { validate as validateTx } from './tx'
import { log } from './log'

export async function validateObject(obj: any):
  Promise<[boolean, MarabuError | undefined, string | undefined]> {
  const object = MarabuObjectSchema.parse(obj)

  switch (object.type) {
    case 'block':
      return [true, undefined, undefined]
    case 'transaction':
      return await validateTx(obj)
    default:
      return [false, 'INVALID_FORMAT', `Unknown object type`]
  }
}

export function hash(obj: any): string | undefined {
  const str = canonicalize(obj)

  if (str === undefined) {
    return str
  }

  return Buffer.from(blake2s(Buffer.from(str, 'utf8'))).toString('hex')
}

class ObjectManager {
  constructor() {
  }
  async has(objectid: string) {
    return await db.has(`object:${objectid}`)
  }
  async get(objectid: string): Promise<MarabuObject | undefined> {
    const objStr = await db.get(`object:${objectid}`)
    if (objStr === undefined) {
      return undefined
    }
    let obj
    let parsed
    try {
      obj = JSON.parse(objStr)
    }
    catch (e) {
      log.warn(`Retrieved object from database, but it is not valid JSON: ${obj}`)
      return undefined
    }
    try {
      parsed = MarabuObjectSchema.parse(obj)
    }
    catch (e: any) {
      log.warn(`Retrieved object from database, but it is unparsable as a Marabu object: ${obj}. Error: ${e.message}`)
      return undefined
    }
    return parsed
  }
  async put(object: any) {
    const str = canonicalize(object)

    if (str === undefined) {
      throw new Error(`Unserializable object ${object}`)
    }
    const objectid = hash(object)
    if (objectid === undefined) {
      throw new Error(`Unhashable object ${object}`)
    }
    await db.put(`object:${objectid}`, str)
  }
}

export const objectManager = new ObjectManager()