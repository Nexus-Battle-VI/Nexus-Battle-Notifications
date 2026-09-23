import { describe, expect, it } from '@jest/globals'
import { HandleAuctionSettledEvent } from '../../../src/application/use-cases/HandleAuctionSettledEvent.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import type { AuctionSettledEventV1 } from '../../../src/application/dto/AuctionSettledEventV1.js'
import type { CatalogNotification } from '../../../src/domain/entities/CatalogNotification.js'

const event = (losers: readonly string[] = ['loser-a', 'loser-b']): AuctionSettledEventV1 => ({
  eventId: 'event-1',
  eventType: 'auction.settled',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt: '2026-01-01T00:00:00.000Z',
  producer: 'auction',
  correlationId: 'correlation-1',
  data: {
    auctionId: 'auction-1',
    productId: 'product-1',
    sellerId: 'seller',
    resultType: 'WITH_WINNER',
    winnerId: 'winner',
    winningBidId: 'bid-1',
    finalAmountCredits: 42,
    loserBidderIds: losers,
    settledAt: '2026-01-01T00:00:00.000Z',
  },
})

describe('HandleAuctionSettledEvent', () => {
  it('crea seller, winner y losers con IDs deterministas y replay durable', async (): Promise<void> => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const handler = new HandleAuctionSettledEvent({
      notifications,
      clock: { now: (): Date => new Date('2026-01-01') },
    })
    expect(await handler.execute(event())).toEqual({ created: 4, duplicated: 0 })
    expect(await handler.execute(event())).toEqual({ created: 0, duplicated: 4 })
    expect(
      (await notifications.findById('auction:auction-1:settled:winner:winner'))?.sourceEventType,
    ).toBe('auction.settled.v1')
  })
  it('un fallo parcial corta y el retry converge sin duplicar', async (): Promise<void> => {
    class FailingRepository extends InMemoryCatalogNotificationRepository {
      fail = true
      override async save(notification: CatalogNotification): Promise<void> {
        if (this.fail && notification.id.endsWith(':loser:loser-a'))
          throw new Error('mongo unavailable')
        await super.save(notification)
      }
    }
    const notifications = new FailingRepository()
    const handler = new HandleAuctionSettledEvent({
      notifications,
      clock: { now: (): Date => new Date() },
    })
    await expect(handler.execute(event())).rejects.toThrow('mongo unavailable')
    expect(await notifications.findById('auction:auction-1:settled:seller:seller')).not.toBeNull()
    expect(await notifications.findById('auction:auction-1:settled:winner:winner')).not.toBeNull()
    expect(await notifications.findById('auction:auction-1:settled:loser:loser-b')).toBeNull()
    notifications.fail = false
    await handler.execute(event())
    expect(await notifications.findHistoryForPlayer('loser-a')).toHaveLength(1)
    expect(await notifications.findHistoryForPlayer('loser-b')).toHaveLength(1)
  })
  it('absorbe una carrera duplicate-key solo si el id aparece despues del insert', async (): Promise<void> => {
    class RacingRepository extends InMemoryCatalogNotificationRepository {
      override async save(notification: CatalogNotification): Promise<void> {
        await super.save(notification)
        throw new Error('E11000 duplicate key')
      }
    }
    const notifications = new RacingRepository()
    const handler = new HandleAuctionSettledEvent({
      notifications,
      clock: { now: (): Date => new Date() },
    })
    await expect(
      handler.execute({
        ...event(),
        data: {
          auctionId: 'race',
          productId: 'product',
          sellerId: 'seller',
          resultType: 'WITHOUT_BIDS',
          settledAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    ).resolves.toEqual({ created: 0, duplicated: 1 })
  })
  it('deduplica losers y aplica precedencia seller > winner > loser', async (): Promise<void> => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const handler = new HandleAuctionSettledEvent({
      notifications,
      clock: { now: (): Date => new Date() },
    })
    await handler.execute(event(['winner', 'seller', 'loser-a', 'loser-a']))
    expect(await notifications.findHistoryForPlayer('winner')).toHaveLength(1)
    expect(await notifications.findHistoryForPlayer('seller')).toHaveLength(1)
    expect(await notifications.findHistoryForPlayer('loser-a')).toHaveLength(1)
  })
  it('WITHOUT_BIDS crea solo la notificacion del seller', async (): Promise<void> => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const handler = new HandleAuctionSettledEvent({
      notifications,
      clock: { now: (): Date => new Date() },
    })
    await handler.execute({
      ...event(),
      data: {
        auctionId: 'auction-1',
        productId: 'product-1',
        sellerId: 'seller',
        resultType: 'WITHOUT_BIDS',
        settledAt: '2026-01-01T00:00:00.000Z',
      },
    })
    expect(await notifications.findHistoryForPlayer('seller')).toHaveLength(1)
  })
})
