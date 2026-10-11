import { createHash } from 'node:crypto'
import {
  parseAuctionConfirmationEvent,
  type AuctionConfirmationEvent,
} from '../dto/AuctionConfirmationEvent.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'
import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'
import { formatCredits, formatNotificationDate } from './notification-text.js'

const notificationId = (eventId: string, role: string): string =>
  createHash('sha256')
    .update(JSON.stringify(['auction-confirmation-v1', eventId, role]))
    .digest('hex')

const publishedDescription = (closesAt: string): string => {
  const closes = formatNotificationDate(closesAt)
  return closes === null
    ? 'Publicaste una subasta.'
    : `Publicaste una subasta. Finaliza el ${closes}.`
}

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
          description: publishedDescription(event.data.closesAt),
        }),
      ]
    }

    const { bidderId, sellerId, amountCredits } = event.data

    return [
      CatalogNotification.create({
        ...common,
        id: notificationId(event.eventId, 'seller'),
        playerId: sellerId,
        changeType: CatalogChangeType.AuctionNewBid,
        description: `Tu subasta recibió una puja de ${formatCredits(amountCredits)}.`,
      }),
      CatalogNotification.create({
        ...common,
        id: notificationId(event.eventId, 'bidder'),
        playerId: bidderId,
        changeType: CatalogChangeType.AuctionBidAccepted,
        description: `Tu puja de ${formatCredits(amountCredits)} fue aceptada.`,
      }),
    ]
  }
}
