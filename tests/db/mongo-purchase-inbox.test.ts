import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { randomUUID } from 'node:crypto'
import { MongoClient, type Db } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import { MongoPurchaseInbox } from '../../src/adapters/idempotency/MongoPurchaseInbox.js'
import { PurchaseConflictError } from '../../src/application/ports/PurchaseInboxPort.js'

describe('Inbox durable de compras', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient
  let db: Db
  beforeAll(async () => {
    const externalUri = process.env['MONGO_TEST_URI']
    if (externalUri === undefined) container = await new MongoDBContainer('mongo:8.0').start()
    client = new MongoClient(
      externalUri ?? `${container!.getConnectionString()}/?directConnection=true`,
    )
    await client.connect()
    db = client.db(`test_notifications_${randomUUID().replaceAll('-', '')}`)
    await new MongoPurchaseInbox(db).ensureIndexes()
  }, 180000)
  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
    await container?.stop()
  })

  it('solo un consumidor reclama; SENT sobrevive a nueva instancia y no caduca', async () => {
    const first = new MongoPurchaseInbox(db)
    const second = new MongoPurchaseInbox(db)
    const claims = await Promise.all([
      first.claim('n1', 'o1', 'fp', 90000),
      second.claim('n1', 'o1', 'fp', 90000),
    ])
    expect(claims.map((c) => c.status).sort()).toEqual(['BUSY', 'CLAIMED'])
    const winner = claims.find((c) => c.status === 'CLAIMED')!
    expect(await second.renew('n1', winner.token, 90000)).toBe(true)
    expect(await second.markSent('n1', 'wrong')).toBe(false)
    expect(await first.markSent('n1', winner.token)).toBe(true)
    expect((await new MongoPurchaseInbox(db).claim('n1', 'o1', 'fp', 90000)).status).toBe('SENT')
    await expect(first.claim('n1', 'o1', 'other', 90000)).rejects.toBeInstanceOf(
      PurchaseConflictError,
    )
    await expect(first.claim('n2', 'o1', 'fp', 90000)).rejects.toBeInstanceOf(PurchaseConflictError)
  })

  it('recupera lease vencido y protege el nuevo token de confirmaciones antiguas', async () => {
    const inbox = new MongoPurchaseInbox(db)
    const old = await inbox.claim('n3', 'o3', 'fp', 90000)
    if (old.status !== 'CLAIMED') throw new Error('claim esperado')
    await db
      .collection<{ _id: string }>('purchase_inbox')
      .updateOne({ _id: 'n3' }, { $set: { leaseUntil: new Date(0) } })
    const next = await inbox.claim('n3', 'o3', 'fp', 90000)
    if (next.status !== 'CLAIMED') throw new Error('claim esperado')
    expect(await inbox.renew('n3', old.token, 90000)).toBe(false)
    expect(await inbox.markSent('n3', old.token)).toBe(false)
    await inbox.release('n3', old.token)
    expect((await inbox.claim('n3', 'o3', 'fp', 90000)).status).toBe('BUSY')
    await inbox.release('n3', next.token)
    expect((await inbox.claim('n3', 'o3', 'fp', 90000)).status).toBe('CLAIMED')
  })
})
