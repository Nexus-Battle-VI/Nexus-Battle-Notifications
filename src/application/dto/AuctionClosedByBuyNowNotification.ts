export interface AuctionClosedByBuyNowNotification {
  readonly operationId: string
  readonly auctionId: string
  readonly recipientId: string
  readonly transactionId: string
  readonly closedAt: string
}
export const AUCTION_CLOSED_BY_BUY_NOW_EVENT_TYPE = 'auction.closed_by_buy_now.v1'
export class InvalidAuctionClosedByBuyNowNotificationError extends Error {}
const field = (o: Record<string, unknown>, key: string): string => {
  const value = o[key]
  if (typeof value !== 'string' || value.trim() === '')
    throw new InvalidAuctionClosedByBuyNowNotificationError(
      `${key} es obligatorio y debe ser texto.`,
    )
  return value
}
export const parseAuctionClosedByBuyNowNotification = (
  value: unknown,
): AuctionClosedByBuyNowNotification => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new InvalidAuctionClosedByBuyNowNotificationError('El cuerpo debe ser un objeto JSON.')
  const o = value as Record<string, unknown>
  const allowed = new Set(['operationId', 'auctionId', 'recipientId', 'transactionId', 'closedAt'])
  if (Object.keys(o).some((key) => !allowed.has(key)))
    throw new InvalidAuctionClosedByBuyNowNotificationError(
      'El cuerpo contiene propiedades no permitidas.',
    )
  const closedAt = field(o, 'closedAt')
  if (Number.isNaN(Date.parse(closedAt)))
    throw new InvalidAuctionClosedByBuyNowNotificationError(
      'closedAt debe ser una fecha ISO-8601 valida.',
    )
  return {
    operationId: field(o, 'operationId'),
    auctionId: field(o, 'auctionId'),
    recipientId: field(o, 'recipientId'),
    transactionId: field(o, 'transactionId'),
    closedAt,
  }
}
