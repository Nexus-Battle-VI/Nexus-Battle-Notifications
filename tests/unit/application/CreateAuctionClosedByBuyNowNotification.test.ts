import { describe, expect, it } from '@jest/globals'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { CreateAuctionClosedByBuyNowNotification } from '../../../src/application/use-cases/CreateAuctionClosedByBuyNowNotification.js'
import { CatalogChangeType } from '../../../src/domain/entities/CatalogChangeType.js'

const command = {
  operationId: 'op-1',
  auctionId: 'auction-1',
  recipientId: 'player-1',
  transactionId: 'txn-1',
  closedAt: '2026-09-24T12:00:00.000Z',
}
const harness = (): {
  notifications: InMemoryCatalogNotificationRepository
  useCase: CreateAuctionClosedByBuyNowNotification
} => {
  const notifications = new InMemoryCatalogNotificationRepository()
  const useCase = new CreateAuctionClosedByBuyNowNotification({
    notifications,
    idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
    clock: new SystemClock(),
    idempotencyTtlMs: 60_000,
  })
  return { notifications, useCase }
}
describe('CreateAuctionClosedByBuyNowNotification', () => {
  it('crea una notificacion dirigida con el tipo y metadata de trazabilidad', async () => {
    const { notifications, useCase } = harness()
    await expect(useCase.execute(command)).resolves.toEqual({
      outcome: 'created',
      notificationId: 'op-1',
    })
    const stored = await notifications.findById('op-1')
    expect(stored?.toSnapshot()).toMatchObject({
      playerId: 'player-1',
      changeType: CatalogChangeType.AuctionClosedByBuyNow,
      sourceEventId: 'op-1',
      implementedAt: new Date(command.closedAt),
    })
    expect(stored?.description).toContain('auction-1')
    expect(stored?.description).toContain('txn-1')
  })
  it('replay exacto no duplica', async () => {
    const { notifications, useCase } = harness()
    await useCase.execute(command)
    await expect(useCase.execute(command)).resolves.toEqual({
      outcome: 'duplicated',
      notificationId: 'op-1',
    })
    expect(await notifications.findHistoryForPlayer('player-1')).toHaveLength(1)
  })
  it.each([{ auctionId: 'other' }, { recipientId: 'other' }, { transactionId: 'other' }])(
    'rechaza operationId con payload incompatible: %o',
    async (change) => {
      const { useCase } = harness()
      await useCase.execute(command)
      await expect(useCase.execute({ ...command, ...change })).rejects.toThrow('operation_conflict')
    },
  )
})
