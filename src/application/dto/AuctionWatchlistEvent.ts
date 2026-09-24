export interface AuctionWatchlistChangedEvent {
  readonly eventId: string
  readonly eventType: 'auction.watchlist.changed.v1'
  readonly auctionId: string
  readonly recipientPlayerIds: readonly string[]
  readonly changeType: 'LEADING_BID_CHANGED'
  readonly occurredAt: string
}

export interface AuctionClosingSoonEvent {
  readonly eventId: string
  readonly eventType: 'auction.closing-soon.v1'
  readonly auctionId: string
  readonly recipientPlayerIds: readonly string[]
  readonly closesAt: string
  readonly occurredAt: string
}

export type AuctionWatchlistEvent = AuctionWatchlistChangedEvent | AuctionClosingSoonEvent
