export interface AuctionBidOutbidNotification {
  /**
   * Identificador estable generado por Auction.
   *
   * Formato utilizado por HU-63.5:
   * <operationId>:outbid
   */
  readonly notificationId: string

  /**
   * Idempotency-Key de la operacion de puja original.
   */
  readonly operationId: string

  /**
   * Identificador estable del jugador desplazado.
   */
  readonly recipientPlayerId: string

  readonly auctionId: string

  /**
   * Puja que acaba de perder el liderazgo.
   */
  readonly outbidBidId: string

  /**
   * Nueva puja lider.
   */
  readonly winningBidId: string

  readonly winningBidderId: string

  readonly winningAmountCredits: number

  /**
   * Momento en que Auction confirmo el resultado de la operacion.
   */
  readonly occurredAt: string
}

export const AUCTION_BID_OUTBID_EVENT_TYPE = 'auction.bid.outbid.v1'

export class InvalidAuctionBidOutbidNotificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAuctionBidOutbidNotificationError'
  }
}

const readString = (source: Record<string, unknown>, field: string): string => {
  const value = source[field]

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidAuctionBidOutbidNotificationError(`${field} es obligatorio y debe ser texto.`)
  }

  return value
}

export const parseAuctionBidOutbidNotification = (value: unknown): AuctionBidOutbidNotification => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAuctionBidOutbidNotificationError('El cuerpo debe ser un objeto JSON.')
  }

  const source = value as Record<string, unknown>

  const winningAmountCredits = source['winningAmountCredits']

  if (!Number.isSafeInteger(winningAmountCredits) || (winningAmountCredits as number) <= 0) {
    throw new InvalidAuctionBidOutbidNotificationError(
      'winningAmountCredits debe ser un entero positivo.',
    )
  }

  const occurredAt = readString(source, 'occurredAt')

  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new InvalidAuctionBidOutbidNotificationError(
      'occurredAt debe ser una fecha ISO-8601 valida.',
    )
  }

  return {
    notificationId: readString(source, 'notificationId'),
    operationId: readString(source, 'operationId'),
    recipientPlayerId: readString(source, 'recipientPlayerId'),
    auctionId: readString(source, 'auctionId'),
    outbidBidId: readString(source, 'outbidBidId'),
    winningBidId: readString(source, 'winningBidId'),
    winningBidderId: readString(source, 'winningBidderId'),
    winningAmountCredits: winningAmountCredits as number,
    occurredAt,
  }
}
