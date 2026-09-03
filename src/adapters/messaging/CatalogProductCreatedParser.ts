import type {
  CatalogProductCreatedEvent,
  ProductType,
} from '../../application/dto/CatalogProductCreatedEvent.js'

export class InvalidEventEnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidEventEnvelopeError'
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const ALLOWED_TYPES: readonly ProductType[] = [
  'HEROE',
  'HABILIDAD',
  'ARMA',
  'ARMADURA',
  'ITEM',
  'EPICA',
]

const readString = (source: Record<string, unknown>, field: string): string => {
  const value = source[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidEventEnvelopeError(
      `El campo "${field}" es obligatorio y debe ser texto no vacio.`,
    )
  }
  return value
}

const assertUuid = (value: string, field: string): void => {
  if (!UUID_REGEX.test(value)) {
    throw new InvalidEventEnvelopeError(
      `El campo "${field}" debe ser un UUID valido v4: "${value}".`,
    )
  }
}

export const parseCatalogProductCreatedEvent = (body: string): CatalogProductCreatedEvent => {
  let parsed: unknown

  try {
    parsed = JSON.parse(body)
  } catch {
    throw new InvalidEventEnvelopeError('El cuerpo del mensaje no es JSON valido.')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidEventEnvelopeError('El sobre del evento debe ser un objeto JSON.')
  }

  const source = parsed as Record<string, unknown>

  const eventType = readString(source, 'eventType')
  if (eventType !== 'catalog.product.created') {
    throw new InvalidEventEnvelopeError(
      `Tipo de evento no reconocido: "${eventType}". Se esperaba "catalog.product.created".`,
    )
  }

  const eventVersion = source['eventVersion']
  if (typeof eventVersion !== 'number' || !Number.isInteger(eventVersion)) {
    throw new InvalidEventEnvelopeError(
      'El campo "eventVersion" es obligatorio y debe ser un entero.',
    )
  }

  if (eventVersion !== 1) {
    throw new InvalidEventEnvelopeError(
      `Version de evento no soportada: "${String(eventVersion)}". Se esperaba version 1.`,
    )
  }

  const eventId = readString(source, 'eventId')
  assertUuid(eventId, 'eventId')

  const aggregateId = readString(source, 'aggregateId')
  assertUuid(aggregateId, 'aggregateId')

  const occurredAt = readString(source, 'occurredAt')
  const dateValue = Date.parse(occurredAt)
  if (Number.isNaN(dateValue)) {
    throw new InvalidEventEnvelopeError(
      `El campo "occurredAt" debe ser una fecha ISO-8601 valida: "${occurredAt}".`,
    )
  }

  const producer = readString(source, 'producer')
  if (producer !== 'catalog') {
    throw new InvalidEventEnvelopeError(
      `El productor "${producer}" no es valido. Se esperaba "catalog".`,
    )
  }

  const correlationId = readString(source, 'correlationId')

  const rawData = source['data']
  if (typeof rawData !== 'object' || rawData === null || Array.isArray(rawData)) {
    throw new InvalidEventEnvelopeError('El campo "data" debe ser un objeto JSON.')
  }

  const data = rawData as Record<string, unknown>

  const productId = readString(data, 'productId')
  assertUuid(productId, 'data.productId')

  if (productId !== aggregateId) {
    throw new InvalidEventEnvelopeError(
      `El aggregateId "${aggregateId}" no coincide con data.productId "${productId}".`,
    )
  }

  const name = readString(data, 'name')
  if (name.length < 3 || name.length > 80) {
    throw new InvalidEventEnvelopeError(
      `El nombre del producto debe tener entre 3 y 80 caracteres: "${name}".`,
    )
  }

  const type = readString(data, 'type') as ProductType
  if (!ALLOWED_TYPES.includes(type)) {
    throw new InvalidEventEnvelopeError(
      `Tipo de producto no admitido: "${type}". Tipos admitidos: ${ALLOWED_TYPES.join(', ')}.`,
    )
  }

  const lifecycleStatus = readString(data, 'lifecycleStatus')
  if (lifecycleStatus !== 'ACTIVE') {
    throw new InvalidEventEnvelopeError(
      `El estado de ciclo de vida del producto creado debe ser "ACTIVE", recibido: "${lifecycleStatus}".`,
    )
  }

  const imageUrl = readString(data, 'imageUrl')

  return {
    eventId,
    eventType: 'catalog.product.created',
    eventVersion: 1,
    aggregateId,
    occurredAt,
    producer: 'catalog',
    correlationId,
    data: {
      productId,
      name,
      type,
      lifecycleStatus: 'ACTIVE',
      imageUrl,
    },
  }
}
