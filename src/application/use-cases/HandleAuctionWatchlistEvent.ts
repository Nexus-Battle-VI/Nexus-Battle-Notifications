import { createHash } from 'node:crypto'
import type { AuctionWatchlistEvent } from '../dto/AuctionWatchlistEvent.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'
import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'

const notificationId = (eventId: string, playerId: string): string =>
  createHash('sha256').update(`${eventId}:${playerId}`, 'utf8').digest('hex')

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000

/** Transforma eventos de Auction en notificaciones in-app persistentes e idempotentes. */
export class HandleAuctionWatchlistEvent {
  private readonly notifications: CatalogNotificationRepositoryPort
  private readonly clock: ClockPort

  constructor(notifications: CatalogNotificationRepositoryPort, clock: ClockPort) {
    this.notifications = notifications
    this.clock = clock
  }

  /** La identidad de cada fila se deriva de evento+destinatario para tolerar reintentos. */
  async execute(event: AuctionWatchlistEvent): Promise<{ created: number; duplicated: number }> {
    let created = 0
    let duplicated = 0
    for (const playerId of [...new Set(event.recipientPlayerIds)].sort()) {
      const id = notificationId(event.eventId, playerId)
      if ((await this.notifications.findById(id)) !== null) {
        duplicated += 1
        continue
      }
      const closing = event.eventType === 'auction.closing-soon.v1'
      const notification = CatalogNotification.create({
        id,
        playerId,
        changeType: closing
          ? CatalogChangeType.AuctionClosingSoon
          : CatalogChangeType.AuctionChanged,
        description: closing
          ? `La subasta ${event.auctionId} finaliza en una hora.`
          : `La puja líder de la subasta ${event.auctionId} cambió.`,
        productId: event.auctionId,
        productName: `Subasta ${event.auctionId}`,
        implementedAt: new Date(event.occurredAt),
        sourceEventId: event.eventId,
        sourceEventType: event.eventType,
        now: this.clock.now(),
      })
      try {
        await this.notifications.save(notification)
        created += 1
      } catch (error: unknown) {
        if (!isDuplicateKey(error)) throw error
        duplicated += 1
      }
    }
    return { created, duplicated }
  }
}
