import { describe, expect, it } from '@jest/globals'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { InMemoryGlobalNotificationReceiptRepository } from '../../../src/adapters/persistence/InMemoryGlobalNotificationReceiptRepository.js'
import { CreateAuctionAutoBidLimitReachedNotification } from '../../../src/application/use-cases/CreateAuctionAutoBidLimitReachedNotification.js'
import { GetPlayerNotifications } from '../../../src/application/use-cases/GetPlayerNotifications.js'
import { CatalogChangeType } from '../../../src/domain/entities/CatalogChangeType.js'

const command = {
  notificationId: 'operation-67-1:auto-bid-limit-reached',
  operationId: 'operation-67-1',
  recipientPlayerId: 'player-1',
  auctionId: 'auction-1',
  autoBidLimitCredits: 500,
  requiredAmountCredits: 550,
  leadingBidderId: 'player-2',
  occurredAt: '2026-09-24T18:00:00.000Z',
}

describe('Visibilidad de AUCTION_AUTO_BID_LIMIT_REACHED en GetPlayerNotifications', () => {
  it('la notificacion creada aparece una sola vez, tambien tras un replay exacto', async () => {
    // Misma instancia de repositorio para escritura y lectura.
    const notifications = new InMemoryCatalogNotificationRepository()
    const create = new CreateAuctionAutoBidLimitReachedNotification({
      notifications,
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      clock: new SystemClock(),
      idempotencyTtlMs: 60_000,
    })
    const read = new GetPlayerNotifications({
      notifications,
      globalReceipts: new InMemoryGlobalNotificationReceiptRepository(),
    })

    await expect(create.execute(command)).resolves.toMatchObject({ outcome: 'created' })

    const pending = await read.pending(command.recipientPlayerId)

    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      id: command.notificationId,
      changeType: CatalogChangeType.AuctionAutoBidLimitReached,
      implementedAt: command.occurredAt,
      productId: null,
      consolidatedCount: 1,
    })
    expect(pending[0]?.changeType).toBe('AUCTION_AUTO_BID_LIMIT_REACHED')
    expect(pending[0]?.description).toContain(command.auctionId)
    expect(pending[0]?.description).toContain(String(command.autoBidLimitCredits))

    await expect(create.execute(command)).resolves.toMatchObject({ outcome: 'duplicated' })

    expect(await read.pending(command.recipientPlayerId)).toHaveLength(1)
    expect(await read.history(command.recipientPlayerId)).toHaveLength(1)
    expect(await read.pending('player-3')).toEqual([])
  })
})
