import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { randomUUID } from 'node:crypto'
import { MongoClient, type Db } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import { MongoCatalogNotificationRepository } from '../../src/adapters/persistence/MongoCatalogNotificationRepository.js'
import { MongoGlobalNotificationReceiptRepository } from '../../src/adapters/persistence/MongoGlobalNotificationReceiptRepository.js'
import { MongoBannerRepository } from '../../src/adapters/persistence/MongoBannerRepository.js'
import { CatalogNotification } from '../../src/domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../src/domain/entities/CatalogChangeType.js'
import { BannerEntry } from '../../src/domain/entities/BannerEntry.js'

const NOW = new Date('2026-09-06T00:00:00.000Z')

describe('Persistencia Mongo de HU-38 (notificaciones y banner)', () => {
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
  }, 180000)

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
    await container?.stop()
  })

  it('CatalogNotification: persiste, distingue pendientes por jugador y conserva el historial tras leer', async () => {
    const repo = new MongoCatalogNotificationRepository(db)
    await repo.ensureIndexes()

    const forA = CatalogNotification.create({
      changeType: CatalogChangeType.ProductSuspended,
      description: 'Mago Hielo fue suspendido temporalmente',
      productId: 'mago-hielo',
      productName: 'Mago Hielo',
      implementedAt: NOW,
      sourceEventId: 'evt-db-1',
      sourceEventType: 'catalog.product.suspended',
      playerId: 'jugador-a',
      now: NOW,
    })
    const forB = CatalogNotification.create({
      changeType: CatalogChangeType.ProductReactivated,
      description: 'Guerrero Tanque fue reactivado y vuelve a estar disponible',
      productId: 'guerrero-tanque',
      implementedAt: NOW,
      sourceEventId: 'evt-db-2',
      sourceEventType: 'catalog.product.reactivated',
      playerId: 'jugador-b',
      now: NOW,
    })
    const global = CatalogNotification.create({
      changeType: CatalogChangeType.ProductCreated,
      description: 'Nuevo producto disponible: Espada de Fuego',
      implementedAt: NOW,
      sourceEventId: 'evt-db-3',
      sourceEventType: 'catalog.product.created',
      now: NOW,
    })

    await repo.save(forA)
    await repo.save(forB)
    await repo.save(global)

    expect(await repo.findPendingForPlayer('jugador-a')).toHaveLength(1)
    expect(await repo.findPendingForPlayer('jugador-b')).toHaveLength(1)
    expect(await repo.findAllGlobal()).toHaveLength(1)

    const reloaded = await repo.findById(forA.id)
    expect(reloaded?.description).toBe('Mago Hielo fue suspendido temporalmente')

    reloaded!.markRead(new Date('2026-09-06T01:00:00.000Z'))
    await repo.updateReadStatus(reloaded!)

    expect(await repo.findPendingForPlayer('jugador-a')).toHaveLength(0)
    const history = await repo.findHistoryForPlayer('jugador-a')
    expect(history).toHaveLength(1)
    expect(history[0]?.readStatus).toBe('READ')
  })

  it('GlobalNotificationReceipt: marcar como leida es idempotente y no afecta a otro jugador', async () => {
    const repo = new MongoGlobalNotificationReceiptRepository(db)
    await repo.ensureIndexes()

    await repo.markRead('jugador-a', ['notif-1', 'notif-2'], NOW)
    await repo.markRead('jugador-a', ['notif-1', 'notif-2'], NOW) // repetido: no debe fallar

    const readByA = await repo.findReadNotificationIds('jugador-a', [
      'notif-1',
      'notif-2',
      'notif-3',
    ])
    expect([...readByA].sort()).toEqual(['notif-1', 'notif-2'])

    const readByB = await repo.findReadNotificationIds('jugador-b', ['notif-1'])
    expect(readByB.size).toBe(0)
  })

  it('BannerRepository: findPublishableAt filtra por fecha de publicacion y conserva entradas expiradas', async () => {
    const repo = new MongoBannerRepository(db)
    await repo.ensureIndexes()

    const vigente = BannerEntry.create({
      title: 'Vigente',
      content: 'x',
      publishAt: new Date('2026-08-01T00:00:00.000Z'),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      createdBy: 'admin-1',
      now: NOW,
    })
    const futura = BannerEntry.create({
      title: 'Futura',
      content: 'x',
      publishAt: new Date('2027-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-02-01T00:00:00.000Z'),
      createdBy: 'admin-1',
      now: NOW,
    })

    await repo.save(vigente)
    await repo.save(futura)

    const publishable = await repo.findPublishableAt(NOW)
    expect(publishable.map((entry) => entry.title)).toEqual(['Vigente'])

    const all = await repo.findAll()
    expect(all).toHaveLength(2)
  })
})
