import type { AuctionClosedByBuyNowNotification } from '../dto/AuctionClosedByBuyNowNotification.js'
import { AUCTION_CLOSED_BY_BUY_NOW_EVENT_TYPE } from '../dto/AuctionClosedByBuyNowNotification.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'
import type { IdempotencyStorePort } from '../ports/IdempotencyStorePort.js'
import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'
export class CreateAuctionClosedByBuyNowNotification {
  private readonly deps: {
    notifications: CatalogNotificationRepositoryPort
    idempotencyStore: IdempotencyStorePort
    clock: ClockPort
    idempotencyTtlMs: number
  }
  constructor(deps: {
    notifications: CatalogNotificationRepositoryPort
    idempotencyStore: IdempotencyStorePort
    clock: ClockPort
    idempotencyTtlMs: number
  }) {
    this.deps = deps
  }
  async execute(
    command: AuctionClosedByBuyNowNotification,
  ): Promise<{ outcome: 'created' | 'duplicated'; notificationId: string }> {
    const existing = await this.deps.notifications.findById(command.operationId)
    if (existing !== null) {
      if (
        existing.sourceEventType !== AUCTION_CLOSED_BY_BUY_NOW_EVENT_TYPE ||
        existing.playerId !== command.recipientId ||
        existing.implementedAt.toISOString() !== new Date(command.closedAt).toISOString() ||
        existing.description !== this.description(command)
      )
        throw new Error('operation_conflict')
      return { outcome: 'duplicated', notificationId: command.operationId }
    }
    const key = `auction:closed-by-buy-now:${command.operationId}`
    if (!(await this.deps.idempotencyStore.reserve(key, this.deps.idempotencyTtlMs)))
      return { outcome: 'duplicated', notificationId: command.operationId }
    try {
      await this.deps.notifications.save(
        CatalogNotification.create({
          id: command.operationId,
          changeType: CatalogChangeType.AuctionClosedByBuyNow,
          description: this.description(command),
          productId: null,
          productName: null,
          implementedAt: new Date(command.closedAt),
          sourceEventId: command.operationId,
          sourceEventType: AUCTION_CLOSED_BY_BUY_NOW_EVENT_TYPE,
          playerId: command.recipientId,
          now: this.deps.clock.now(),
        }),
      )
      await this.deps.idempotencyStore.confirm(key)
      return { outcome: 'created', notificationId: command.operationId }
    } catch (error) {
      await this.deps.idempotencyStore.release(key)
      throw error
    }
  }

  private description(command: AuctionClosedByBuyNowNotification): string {
    return `La subasta ${command.auctionId} termino por compra inmediata. Transaccion ${command.transactionId}.`
  }
}
