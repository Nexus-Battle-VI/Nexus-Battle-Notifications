import { describe, expect, it } from '@jest/globals'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { HandleAuctionWatchlistEvent } from '../../../src/application/use-cases/HandleAuctionWatchlistEvent.js'

const changed = {
  eventId: 'operation-1:watchlist-change',
  eventType: 'auction.watchlist.changed.v1' as const,
  auctionId: 'auction-1',
  recipientPlayerIds: ['player-1', 'player-2', 'player-1'],
  changeType: 'LEADING_BID_CHANGED' as const,
  occurredAt: '2026-09-21T12:00:00.000Z',
}

/** TASK 68.4: recepción, persistencia e idempotencia por evento/destinatario. */
describe('HandleAuctionWatchlistEvent', () => {
  it('crea una notificación persistente para cada destinatario único', async (): Promise<void> => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const useCase = new HandleAuctionWatchlistEvent(notifications, {
      now: (): Date => new Date('2026-09-21T12:00:01.000Z'),
    })

    await expect(useCase.execute(changed)).resolves.toEqual({ created: 2, duplicated: 0 })
    expect(await notifications.findPendingForPlayer('player-1')).toHaveLength(1)
    expect((await notifications.findPendingForPlayer('player-2'))[0]?.toSnapshot()).toMatchObject({
      changeType: 'AUCTION_CHANGED',
      productId: 'auction-1',
      sourceEventId: changed.eventId,
    })
  })

  it('un replay no crea notificaciones duplicadas', async (): Promise<void> => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const useCase = new HandleAuctionWatchlistEvent(notifications, { now: (): Date => new Date() })
    await useCase.execute(changed)

    await expect(useCase.execute(changed)).resolves.toEqual({ created: 0, duplicated: 2 })
    expect(await notifications.findPendingForPlayer('player-1')).toHaveLength(1)
  })

  it('genera el texto del recordatorio de cierre próximo', async (): Promise<void> => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const useCase = new HandleAuctionWatchlistEvent(notifications, { now: (): Date => new Date() })
    await useCase.execute({
      eventId: 'auction-1:closing:2026-09-21T13:00:00.000Z',
      eventType: 'auction.closing-soon.v1',
      auctionId: 'auction-1',
      recipientPlayerIds: ['player-1'],
      closesAt: '2026-09-21T13:00:00.000Z',
      occurredAt: '2026-09-21T12:00:00.000Z',
    })

    expect((await notifications.findPendingForPlayer('player-1'))[0]?.description).toContain(
      'finaliza en una hora',
    )
  })
})
