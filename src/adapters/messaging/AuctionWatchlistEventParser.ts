import type { AuctionWatchlistEvent } from '../../application/dto/AuctionWatchlistEvent.js'

export class InvalidAuctionWatchlistEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAuctionWatchlistEventError'
  }
}

const readText = (source: Record<string, unknown>, key: string): string => {
  const value = source[key]
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new InvalidAuctionWatchlistEventError(`${key} debe ser texto no vacío.`)
  return value
}

/** Parser estricto del contrato versionado producido por Auction. */
export const parseAuctionWatchlistEvent = (value: unknown): AuctionWatchlistEvent => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new InvalidAuctionWatchlistEventError('El evento debe ser un objeto JSON.')
  const source = value as Record<string, unknown>
  const eventType = readText(source, 'eventType')
  if (eventType !== 'auction.watchlist.changed.v1' && eventType !== 'auction.closing-soon.v1')
    throw new InvalidAuctionWatchlistEventError('eventType no está soportado.')
  const recipients = source['recipientPlayerIds']
  if (
    !Array.isArray(recipients) ||
    recipients.length === 0 ||
    !recipients.every((recipient) => typeof recipient === 'string' && recipient.trim().length > 0)
  )
    throw new InvalidAuctionWatchlistEventError('recipientPlayerIds debe contener jugadores.')
  const occurredAt = readText(source, 'occurredAt')
  if (Number.isNaN(Date.parse(occurredAt)))
    throw new InvalidAuctionWatchlistEventError('occurredAt debe ser ISO-8601.')
  const base = {
    eventId: readText(source, 'eventId'),
    auctionId: readText(source, 'auctionId'),
    recipientPlayerIds: recipients,
    occurredAt,
  }
  if (eventType === 'auction.watchlist.changed.v1') {
    if (source['changeType'] !== 'LEADING_BID_CHANGED')
      throw new InvalidAuctionWatchlistEventError('changeType no está soportado.')
    return { ...base, eventType, changeType: 'LEADING_BID_CHANGED' }
  }
  const closesAt = readText(source, 'closesAt')
  if (Number.isNaN(Date.parse(closesAt)))
    throw new InvalidAuctionWatchlistEventError('closesAt debe ser ISO-8601.')
  return { ...base, eventType, closesAt }
}
