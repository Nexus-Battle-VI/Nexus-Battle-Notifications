import { describe, expect, it } from '@jest/globals'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { InMemoryGlobalNotificationReceiptRepository } from '../../../src/adapters/persistence/InMemoryGlobalNotificationReceiptRepository.js'
import { CreateAuctionClosedByBuyNowNotification } from '../../../src/application/use-cases/CreateAuctionClosedByBuyNowNotification.js'
import { GetPlayerNotifications } from '../../../src/application/use-cases/GetPlayerNotifications.js'
import { CatalogChangeType } from '../../../src/domain/entities/CatalogChangeType.js'

const command = {
  operationId: 'op-buy-now-1',
  auctionId: 'auction-1',
  recipientId: 'player-1',
  transactionId: 'tx-1',
  closedAt: '2026-09-24T14:00:00.000Z',
}

describe('Visibilidad de AUCTION_CLOSED_BY_BUY_NOW en GetPlayerNotifications', () => {
  it('la notificacion creada aparece una sola vez, tambien tras un replay exacto', async () => {
    // Misma instancia de repositorio para escritura y lectura.
    const notifications = new InMemoryCatalogNotificationRepository()
    const create = new CreateAuctionClosedByBuyNowNotification({
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

    const pending = await read.pending(command.recipientId)

    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      id: command.operationId,
      changeType: CatalogChangeType.AuctionClosedByBuyNow,
      implementedAt: command.closedAt,
      productId: null,
      consolidatedCount: 1,
    })
    expect(pending[0]?.changeType).toBe('AUCTION_CLOSED_BY_BUY_NOW')
    expect(pending[0]?.description).toContain(command.auctionId)
    expect(pending[0]?.description).toContain(command.transactionId)

    await expect(create.execute(command)).resolves.toMatchObject({ outcome: 'duplicated' })

    expect(await read.pending(command.recipientId)).toHaveLength(1)
    expect(await read.history(command.recipientId)).toHaveLength(1)
    expect(await read.pending('player-2')).toEqual([])
  })
})
