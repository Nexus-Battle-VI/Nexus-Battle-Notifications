import { createHash } from 'node:crypto'
import {
  parseAuctionConfirmationEvent,
  type AuctionConfirmationEvent,
} from '../dto/AuctionConfirmationEvent.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'
import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'

const notificationId = (eventId: string, role: string): string =>
  createHash('sha256')
    .update(JSON.stringify(['auction-confirmation-v1', eventId, role]))
    .digest('hex')

const assertSame = (existing: CatalogNotification, expected: CatalogNotification): void => {
  if (
    existing.audience !== expected.audience ||
    existing.playerId !== expected.playerId ||
    existing.changeType !== expected.changeType ||
    existing.description !== expected.description ||
    existing.productId !== expected.productId ||
    existing.productName !== expected.productName ||
    existing.implementedAt.getTime() !== expected.implementedAt.getTime() ||
    existing.sourceEventId !== expected.sourceEventId ||
    existing.sourceEventType !== expected.sourceEventType
  ) {
    throw new Error('operation_conflict')
  }
}

export class HandleAuctionConfirmationEvent {
  private readonly notifications: CatalogNotificationRepositoryPort
  private readonly clock: ClockPort

  constructor(notifications: CatalogNotificationRepositoryPort, clock: ClockPort) {
    this.notifications = notifications
    this.clock = clock
  }

  async execute(input: AuctionConfirmationEvent): Promise<{
    eventId: string
    created: number
    duplicated: number
  }> {
    const event = parseAuctionConfirmationEvent(input)
    const expected = this.notificationsFor(event)

    // Comprueba conflictos antes de guardar destinatarios nuevos.
    for (const notification of expected) {
      const existing = await this.notifications.findById(notification.id)

      if (existing !== null) {
        assertSame(existing, notification)
      }
    }

    let created = 0
    let duplicated = 0

    for (const notification of expected) {
      const existing = await this.notifications.findById(notification.id)

      if (existing !== null) {
        assertSame(existing, notification)
        duplicated += 1
        continue
      }

      try {
        await this.notifications.save(notification)
        created += 1
      } catch (error: unknown) {
        const persisted = await this.notifications.findById(notification.id)

        if (persisted === null) {
          throw error
        }

        assertSame(persisted, notification)
        duplicated += 1
      }
    }

    return {
      eventId: event.eventId,
      created,
      duplicated,
    }
  }

  private notificationsFor(event: AuctionConfirmationEvent): readonly CatalogNotification[] {
    const common = {
      productId: event.data.productId,
      productName: null,
      implementedAt: new Date(event.occurredAt),
      sourceEventId: event.eventId,
      sourceEventType: `${event.eventType}.v1`,
      now: this.clock.now(),
    }

    if (event.eventType === 'auction.published') {
      return [
        CatalogNotification.create({
          ...common,
          id: notificationId(event.eventId, 'seller'),
          playerId: event.data.sellerId,
          changeType: CatalogChangeType.AuctionPublished,
          description: `Publicaste la subasta ${event.data.auctionId} del producto ${event.data.productId}. Finaliza el ${event.data.closesAt}.`,
        }),
      ]
    }

    const { auctionId, bidderId, sellerId, bidId, amountCredits } = event.data

    return [
      CatalogNotification.create({
        ...common,
        id: notificationId(event.eventId, 'seller'),
        playerId: sellerId,
        changeType: CatalogChangeType.AuctionNewBid,
        description: `La subasta ${auctionId} recibio la puja ${bidId} del jugador ${bidderId} por ${String(amountCredits)} creditos.`,
      }),
      CatalogNotification.create({
        ...common,
        id: notificationId(event.eventId, 'bidder'),
        playerId: bidderId,
        changeType: CatalogChangeType.AuctionBidAccepted,
        description: `Tu puja ${bidId} en la subasta ${auctionId} por ${String(amountCredits)} creditos fue aceptada.`,
      }),
    ]
  }
}
