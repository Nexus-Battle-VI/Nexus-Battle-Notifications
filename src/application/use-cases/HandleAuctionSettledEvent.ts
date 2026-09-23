import type { AuctionSettledEventV1 } from '../dto/AuctionSettledEventV1.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'
import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'

export interface HandleAuctionSettledEventDependencies {
  readonly notifications: CatalogNotificationRepositoryPort
  readonly clock: ClockPort
}

export class HandleAuctionSettledEvent {
  private readonly deps: HandleAuctionSettledEventDependencies
  constructor(deps: HandleAuctionSettledEventDependencies) {
    this.deps = deps
  }

  async execute(
    event: AuctionSettledEventV1,
  ): Promise<{ readonly created: number; readonly duplicated: number }> {
    const recipients = this.recipients(event)
    let created = 0
    let duplicated = 0
    for (const recipient of recipients) {
      if (await this.deps.notifications.findById(recipient.id)) {
        duplicated += 1
        continue
      }
      const notification = CatalogNotification.create({
        id: recipient.id,
        playerId: recipient.playerId,
        changeType: recipient.changeType,
        description: recipient.description,
        productId: event.data.productId,
        productName: null,
        implementedAt: new Date(event.data.settledAt),
        sourceEventId: event.eventId,
        sourceEventType: 'auction.settled.v1',
        now: this.deps.clock.now(),
      })
      try {
        await this.deps.notifications.save(notification)
        created += 1
      } catch (error: unknown) {
        // Mongo duplicate-key races are successful replays only if the deterministic id exists.
        if (await this.deps.notifications.findById(recipient.id)) {
          duplicated += 1
          continue
        }
        throw error
      }
    }
    return { created, duplicated }
  }

  private recipients(event: AuctionSettledEventV1): readonly {
    id: string
    playerId: string
    changeType: CatalogChangeType
    description: string
  }[] {
    const { auctionId, productId, sellerId } = event.data
    const result: {
      id: string
      playerId: string
      changeType: CatalogChangeType
      description: string
    }[] = [
      {
        id: `auction:${auctionId}:settled:seller:${sellerId}`,
        playerId: sellerId,
        changeType:
          event.data.resultType === 'WITHOUT_BIDS'
            ? CatalogChangeType.AuctionSettledWithoutBids
            : CatalogChangeType.AuctionSettledSeller,
        description:
          event.data.resultType === 'WITHOUT_BIDS'
            ? `La subasta ${auctionId} del producto ${productId} finalizo sin pujas.`
            : `La subasta ${auctionId} del producto ${productId} finalizo con una venta.`,
      },
    ]
    if (event.data.resultType === 'WITHOUT_BIDS') return result
    const seen = new Set([sellerId]) // deterministic precedence: seller > winner > loser
    if (!seen.has(event.data.winnerId)) {
      seen.add(event.data.winnerId)
      result.push({
        id: `auction:${auctionId}:settled:winner:${event.data.winnerId}`,
        playerId: event.data.winnerId,
        changeType: CatalogChangeType.AuctionSettledWinner,
        description: `Ganaste la subasta ${auctionId} del producto ${productId} por ${String(event.data.finalAmountCredits)} creditos.`,
      })
    }
    for (const loserId of event.data.loserBidderIds)
      if (!seen.has(loserId)) {
        seen.add(loserId)
        result.push({
          id: `auction:${auctionId}:settled:loser:${loserId}`,
          playerId: loserId,
          changeType: CatalogChangeType.AuctionSettledLoser,
          description: `No ganaste la subasta ${auctionId} del producto ${productId}.`,
        })
      }
    return result
  }
}
