export interface AuctionPublishedEventV1 {
  readonly eventId: string
  readonly eventType: 'auction.published'
  readonly eventVersion: 1
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: 'auction'
  readonly correlationId: string
  readonly data: {
    readonly auctionId: string
    readonly sellerId: string
    readonly productId: string
    readonly publishedAt: string
    readonly closesAt: string
  }
}

export interface AuctionBidAcceptedEventV1 {
  readonly eventId: string
  readonly eventType: 'auction.bid.accepted'
  readonly eventVersion: 1
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: 'auction'
  readonly correlationId: string
  readonly data: {
    readonly operationId: string
    readonly auctionId: string
    readonly productId: string
    readonly sellerId: string
    readonly bidderId: string
    readonly bidId: string
    readonly amountCredits: number
    readonly acceptedAt: string
  }
}

export type AuctionConfirmationEvent = AuctionPublishedEventV1 | AuctionBidAcceptedEventV1

export class InvalidAuctionConfirmationEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAuctionConfirmationEventError'
  }
}

const invalid = (message: string): never => {
  throw new InvalidAuctionConfirmationEventError(message)
}

const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid('El contrato debe contener objetos JSON.')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some((key) => !keys.includes(key)))
    return invalid('El contrato contiene propiedades no permitidas.')
  return result
}

const text = (value: Record<string, unknown>, key: string): string => {
  const result = value[key]
  if (typeof result !== 'string' || result.trim() === '' || result !== result.trim())
    return invalid(`${key} debe ser texto no vacio sin espacios en los extremos.`)
  return result
}

const date = (value: Record<string, unknown>, key: string): string => {
  const result = text(value, key)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result))
    return invalid(`${key} debe ser una fecha ISO-8601 UTC con milisegundos.`)
  const parsed = new Date(result)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result)
    return invalid(`${key} contiene una fecha invalida.`)
  return result
}

export const parseAuctionConfirmationEvent = (value: unknown): AuctionConfirmationEvent => {
  const envelope = object(value, [
    'eventId',
    'eventType',
    'eventVersion',
    'aggregateId',
    'occurredAt',
    'producer',
    'correlationId',
    'data',
  ])
  if (envelope['producer'] !== 'auction' || envelope['eventVersion'] !== 1)
    return invalid('Productor o version no soportados.')
  const common = {
    eventId: text(envelope, 'eventId'),
    eventVersion: 1 as const,
    aggregateId: text(envelope, 'aggregateId'),
    occurredAt: date(envelope, 'occurredAt'),
    producer: 'auction' as const,
    correlationId: text(envelope, 'correlationId'),
  }
  if (envelope['eventType'] === 'auction.published') {
    const raw = object(envelope['data'], [
      'auctionId',
      'sellerId',
      'productId',
      'publishedAt',
      'closesAt',
    ])
    const data = {
      auctionId: text(raw, 'auctionId'),
      sellerId: text(raw, 'sellerId'),
      productId: text(raw, 'productId'),
      publishedAt: date(raw, 'publishedAt'),
      closesAt: date(raw, 'closesAt'),
    }
    if (
      common.aggregateId !== data.auctionId ||
      common.occurredAt !== data.publishedAt ||
      Date.parse(data.closesAt) <= Date.parse(data.publishedAt)
    )
      return invalid('La publicacion contiene identificadores o fechas inconsistentes.')
    return { ...common, eventType: 'auction.published', data }
  }
  if (envelope['eventType'] === 'auction.bid.accepted') {
    const raw = object(envelope['data'], [
      'operationId',
      'auctionId',
      'productId',
      'sellerId',
      'bidderId',
      'bidId',
      'amountCredits',
      'acceptedAt',
    ])
    const amountCredits = raw['amountCredits']
    if (
      typeof amountCredits !== 'number' ||
      !Number.isSafeInteger(amountCredits) ||
      amountCredits <= 0
    )
      return invalid('amountCredits debe ser un entero positivo seguro.')
    const data = {
      operationId: text(raw, 'operationId'),
      auctionId: text(raw, 'auctionId'),
      productId: text(raw, 'productId'),
      sellerId: text(raw, 'sellerId'),
      bidderId: text(raw, 'bidderId'),
      bidId: text(raw, 'bidId'),
      amountCredits,
      acceptedAt: date(raw, 'acceptedAt'),
    }
    if (
      common.aggregateId !== data.auctionId ||
      common.occurredAt !== data.acceptedAt ||
      common.correlationId !== data.operationId ||
      common.eventId !== `${data.operationId}:bid-accepted` ||
      data.sellerId === data.bidderId
    )
      return invalid('La puja contiene identificadores, destinatarios o fechas inconsistentes.')
    return { ...common, eventType: 'auction.bid.accepted', data }
  }
  return invalid('Tipo de evento no soportado.')
}
