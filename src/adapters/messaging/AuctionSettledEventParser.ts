import type { AuctionSettledEventV1 } from '../../application/dto/AuctionSettledEventV1.js'

export class InvalidAuctionSettledEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAuctionSettledEventError'
  }
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '')
    throw new InvalidAuctionSettledEventError(`${field} es obligatorio.`)
  return value
}

const date = (value: unknown, field: string): string => {
  const result = text(value, field)
  if (Number.isNaN(Date.parse(result)))
    throw new InvalidAuctionSettledEventError(`${field} debe ser ISO.`)
  return result
}

export const parseAuctionSettledEventV1 = (body: string): AuctionSettledEventV1 => {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    throw new InvalidAuctionSettledEventError('El cuerpo no es JSON valido.')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new InvalidAuctionSettledEventError('El sobre debe ser un objeto.')
  const event = raw as Record<string, unknown>
  if (
    event['eventType'] !== 'auction.settled' ||
    event['eventVersion'] !== 1 ||
    event['producer'] !== 'auction'
  )
    throw new InvalidAuctionSettledEventError('Contrato auction.settled.v1 no soportado.')
  const data = event['data']
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new InvalidAuctionSettledEventError('data debe ser un objeto.')
  const d = data as Record<string, unknown>
  const common = {
    auctionId: text(d['auctionId'], 'data.auctionId'),
    productId: text(d['productId'], 'data.productId'),
    sellerId: text(d['sellerId'], 'data.sellerId'),
    settledAt: date(d['settledAt'], 'data.settledAt'),
  }
  const envelope = {
    eventId: text(event['eventId'], 'eventId'),
    eventType: 'auction.settled' as const,
    eventVersion: 1 as const,
    aggregateId: text(event['aggregateId'], 'aggregateId'),
    occurredAt: date(event['occurredAt'], 'occurredAt'),
    producer: 'auction' as const,
    correlationId: text(event['correlationId'], 'correlationId'),
  }
  if (d['resultType'] === 'WITHOUT_BIDS')
    return { ...envelope, data: { ...common, resultType: 'WITHOUT_BIDS' } }
  if (
    d['resultType'] !== 'WITH_WINNER' ||
    !Array.isArray(d['loserBidderIds']) ||
    !d['loserBidderIds'].every((id) => typeof id === 'string' && id.trim() !== '') ||
    typeof d['finalAmountCredits'] !== 'number' ||
    !Number.isFinite(d['finalAmountCredits'])
  )
    throw new InvalidAuctionSettledEventError('Payload WITH_WINNER invalido.')
  return {
    ...envelope,
    data: {
      ...common,
      resultType: 'WITH_WINNER',
      winnerId: text(d['winnerId'], 'data.winnerId'),
      winningBidId: text(d['winningBidId'], 'data.winningBidId'),
      finalAmountCredits: d['finalAmountCredits'],
      loserBidderIds: d['loserBidderIds'],
    },
  }
}
