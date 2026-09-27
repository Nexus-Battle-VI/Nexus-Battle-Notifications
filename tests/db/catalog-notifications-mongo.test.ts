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
import { HandleAuctionSettledEvent } from '../../src/application/use-cases/HandleAuctionSettledEvent.js'
import { CreateAuctionClosedByBuyNowNotification } from '../../src/application/use-cases/CreateAuctionClosedByBuyNowNotification.js'
import { InMemoryIdempotencyStore } from '../../src/adapters/idempotency/InMemoryIdempotencyStore.js'

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

  it('HU-65.6: _id determinista persiste settlement y un handler/repository nuevo absorbe replay', async () => {
    const firstRepository = new MongoCatalogNotificationRepository(db)
    const event = {
      eventId: 'auction-settled-event',
      eventType: 'auction.settled' as const,
      eventVersion: 1 as const,
      aggregateId: 'auction-settled',
      occurredAt: NOW.toISOString(),
      producer: 'auction' as const,
      correlationId: 'settlement',
      data: {
        auctionId: 'auction-settled',
        productId: 'product-settled',
        sellerId: 'seller-settled',
        resultType: 'WITHOUT_BIDS' as const,
        settledAt: NOW.toISOString(),
      },
    }
    await new HandleAuctionSettledEvent({
      notifications: firstRepository,
      clock: { now: (): Date => NOW },
    }).execute(event)
    const id = 'auction:auction-settled:settled:seller:seller-settled'
    expect(await firstRepository.findById(id)).toMatchObject({
      id,
      sourceEventId: event.eventId,
      sourceEventType: 'auction.settled.v1',
    })
    const secondRepository = new MongoCatalogNotificationRepository(db)
    await expect(
      new HandleAuctionSettledEvent({
        notifications: secondRepository,
        clock: { now: (): Date => NOW },
      }).execute(event),
    ).resolves.toEqual({ created: 0, duplicated: 1 })
  })

  it('HU-64.5: persiste AUCTION_CLOSED_BY_BUY_NOW y un repository nuevo la lee y absorbe replay', async () => {
    const command = {
      operationId: 'op-buy-now-mongo',
      auctionId: 'auction-buy-now-mongo',
      recipientId: 'player-buy-now-mongo',
      transactionId: 'tx-buy-now-mongo',
      closedAt: '2026-09-24T14:00:00.000Z',
    }
    const useCaseFor = (
      notifications: MongoCatalogNotificationRepository,
    ): CreateAuctionClosedByBuyNowNotification =>
      new CreateAuctionClosedByBuyNowNotification({
        notifications,
        idempotencyStore: new InMemoryIdempotencyStore(() => NOW.getTime()),
        clock: { now: (): Date => NOW },
        idempotencyTtlMs: 60_000,
      })

    await expect(
      useCaseFor(new MongoCatalogNotificationRepository(db)).execute(command),
    ).resolves.toEqual({ outcome: 'created', notificationId: command.operationId })

    const secondRepository = new MongoCatalogNotificationRepository(db)
    const stored = await secondRepository.findById(command.operationId)
    expect(stored).toMatchObject({
      id: command.operationId,
      playerId: command.recipientId,
      changeType: CatalogChangeType.AuctionClosedByBuyNow,
      sourceEventId: command.operationId,
      sourceEventType: 'auction.closed_by_buy_now.v1',
    })
    expect(stored?.implementedAt.toISOString()).toBe(command.closedAt)
    expect(stored?.description).toContain(command.auctionId)
    expect(stored?.description).toContain(command.transactionId)

    const pending = await secondRepository.findPendingForPlayer(command.recipientId)
    expect(pending.map((notification) => notification.id)).toEqual([command.operationId])

    const secondUseCase = useCaseFor(secondRepository)
    await expect(secondUseCase.execute(command)).resolves.toEqual({
      outcome: 'duplicated',
      notificationId: command.operationId,
    })
    await expect(secondUseCase.execute({ ...command, auctionId: 'auction-other' })).rejects.toThrow(
      'operation_conflict',
    )
    expect(await secondRepository.findHistoryForPlayer(command.recipientId)).toHaveLength(1)
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
