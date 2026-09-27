export interface AuctionAutoBidLimitReachedNotification {
  /**
   * Identificador estable generado por Auction.
   *
   * Formato utilizado por HU-67: <operationId>:auto-bid-limit-reached
   */
  readonly notificationId: string

  /**
   * Idempotency-Key de la reaccion automatica original.
   */
  readonly operationId: string

  /**
   * Identificador estable del jugador cuya puja automatica alcanzo su limite.
   */
  readonly recipientPlayerId: string

  readonly auctionId: string

  /**
   * Limite maximo configurado por el jugador (HU-67.1).
   */
  readonly autoBidLimitCredits: number

  /**
   * Monto que habria hecho falta pujar para recuperar el liderazgo.
   */
  readonly requiredAmountCredits: number

  /**
   * Postor que desplazo al jugador y que su puja automatica no pudo superar.
   */
  readonly leadingBidderId: string

  /**
   * Momento en que Auction confirmo que el limite fue alcanzado.
   */
  readonly occurredAt: string
}

export const AUCTION_AUTO_BID_LIMIT_REACHED_EVENT_TYPE = 'auction.auto-bid.limit-reached.v1'

export class InvalidAuctionAutoBidLimitReachedNotificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAuctionAutoBidLimitReachedNotificationError'
  }
}

const readString = (source: Record<string, unknown>, field: string): string => {
  const value = source[field]

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidAuctionAutoBidLimitReachedNotificationError(
      `${field} es obligatorio y debe ser texto.`,
    )
  }

  return value
}

const readPositiveInteger = (source: Record<string, unknown>, field: string): number => {
  const value = source[field]

  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new InvalidAuctionAutoBidLimitReachedNotificationError(
      `${field} debe ser un entero positivo.`,
    )
  }

  return value as number
}

export const parseAuctionAutoBidLimitReachedNotification = (
  value: unknown,
): AuctionAutoBidLimitReachedNotification => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAuctionAutoBidLimitReachedNotificationError(
      'El cuerpo debe ser un objeto JSON.',
    )
  }

  const source = value as Record<string, unknown>

  const allowed = new Set([
    'notificationId',
    'operationId',
    'recipientPlayerId',
    'auctionId',
    'autoBidLimitCredits',
    'requiredAmountCredits',
    'leadingBidderId',
    'occurredAt',
  ])

  if (Object.keys(source).some((key) => !allowed.has(key))) {
    throw new InvalidAuctionAutoBidLimitReachedNotificationError(
      'El cuerpo contiene propiedades no permitidas.',
    )
  }

  const occurredAt = readString(source, 'occurredAt')

  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new InvalidAuctionAutoBidLimitReachedNotificationError(
      'occurredAt debe ser una fecha ISO-8601 valida.',
    )
  }

  const recipientPlayerId = readString(source, 'recipientPlayerId')
  const leadingBidderId = readString(source, 'leadingBidderId')

  if (recipientPlayerId === leadingBidderId) {
    throw new InvalidAuctionAutoBidLimitReachedNotificationError(
      'El jugador cuyo limite se alcanzo no puede ser quien lo desplazo.',
    )
  }

  return {
    notificationId: readString(source, 'notificationId'),
    operationId: readString(source, 'operationId'),
    recipientPlayerId,
    auctionId: readString(source, 'auctionId'),
    autoBidLimitCredits: readPositiveInteger(source, 'autoBidLimitCredits'),
    requiredAmountCredits: readPositiveInteger(source, 'requiredAmountCredits'),
    leadingBidderId,
    occurredAt,
  }
}
