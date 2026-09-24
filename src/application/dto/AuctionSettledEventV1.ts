export interface AuctionSettledWithWinnerData {
  readonly auctionId: string
  readonly productId: string
  readonly sellerId: string
  readonly resultType: 'WITH_WINNER'
  readonly winnerId: string
  readonly winningBidId: string
  readonly finalAmountCredits: number
  readonly loserBidderIds: readonly string[]
  readonly settledAt: string
}

export interface AuctionSettledWithoutBidsData {
  readonly auctionId: string
  readonly productId: string
  readonly sellerId: string
  readonly resultType: 'WITHOUT_BIDS'
  readonly settledAt: string
}

export type AuctionSettledEventV1 = Readonly<{
  eventId: string
  eventType: 'auction.settled'
  eventVersion: 1
  aggregateId: string
  occurredAt: string
  producer: 'auction'
  correlationId: string
  data: AuctionSettledWithWinnerData | AuctionSettledWithoutBidsData
}>
