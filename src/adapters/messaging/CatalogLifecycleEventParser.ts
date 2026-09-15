import {
  CatalogLifecycleEventType,
  type CatalogLifecycleEvent,
  type LifecycleProductType,
} from '../../application/dto/CatalogLifecycleEvent.js'

export class InvalidLifecycleEventEnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidLifecycleEventEnvelopeError'
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const ALLOWED_TYPES: readonly LifecycleProductType[] = [
  'HEROE',
  'HABILIDAD',
  'ARMA',
  'ARMADURA',
  'ITEM',
  'EPICA',
]

const ALLOWED_EVENT_TYPES: readonly CatalogLifecycleEventType[] = [
  CatalogLifecycleEventType.Suspended,
  CatalogLifecycleEventType.Reactivated,
  CatalogLifecycleEventType.InventoryAdjusted,
  CatalogLifecycleEventType.PremiumConfigured,
]

const readString = (source: Record<string, unknown>, field: string): string => {
  const value = source[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidLifecycleEventEnvelopeError(
      `El campo "${field}" es obligatorio y debe ser texto no vacio.`,
    )
  }
  return value
}

const assertUuid = (value: string, field: string): void => {
  if (!UUID_REGEX.test(value)) {
    throw new InvalidLifecycleEventEnvelopeError(
      `El campo "${field}" debe ser un UUID valido: "${value}".`,
    )
  }
}

/**
 * Un único parser para los cuatro `eventType` de ciclo de vida: comparten
 * envelope y forma de `data` (ver CatalogLifecycleEvent.ts), así que
 * duplicar un parser por tipo solo repetiría la misma validación cuatro
 * veces sin ganar nada.
 */
export const parseCatalogLifecycleEvent = (body: string): CatalogLifecycleEvent => {
  let parsed: unknown

  try {
    parsed = JSON.parse(body)
  } catch {
    throw new InvalidLifecycleEventEnvelopeError('El cuerpo del mensaje no es JSON valido.')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidLifecycleEventEnvelopeError('El sobre del evento debe ser un objeto JSON.')
  }

  const source = parsed as Record<string, unknown>

  const eventType = readString(source, 'eventType')
  if (!(ALLOWED_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new InvalidLifecycleEventEnvelopeError(
      `Tipo de evento no reconocido: "${eventType}". Se esperaba uno de: ${ALLOWED_EVENT_TYPES.join(', ')}.`,
    )
  }

  const eventVersion = source['eventVersion']
  if (typeof eventVersion !== 'number' || !Number.isInteger(eventVersion) || eventVersion !== 1) {
    throw new InvalidLifecycleEventEnvelopeError(
      'El campo "eventVersion" debe ser el entero 1 (unica version soportada).',
    )
  }

  const eventId = readString(source, 'eventId')
  assertUuid(eventId, 'eventId')

  const aggregateId = readString(source, 'aggregateId')
  assertUuid(aggregateId, 'aggregateId')

  const occurredAt = readString(source, 'occurredAt')
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new InvalidLifecycleEventEnvelopeError(
      `El campo "occurredAt" debe ser una fecha ISO-8601 valida: "${occurredAt}".`,
    )
  }

  const producer = readString(source, 'producer')
  if (producer !== 'catalog') {
    throw new InvalidLifecycleEventEnvelopeError(
      `El productor "${producer}" no es valido. Se esperaba "catalog".`,
    )
  }

  const correlationId = readString(source, 'correlationId')

  const rawData = source['data']
  if (typeof rawData !== 'object' || rawData === null || Array.isArray(rawData)) {
    throw new InvalidLifecycleEventEnvelopeError('El campo "data" debe ser un objeto JSON.')
  }

  const data = rawData as Record<string, unknown>

  const productId = readString(data, 'productId')
  assertUuid(productId, 'data.productId')

  if (productId !== aggregateId) {
    throw new InvalidLifecycleEventEnvelopeError(
      `El aggregateId "${aggregateId}" no coincide con data.productId "${productId}".`,
    )
  }

  const name = readString(data, 'name')

  const type = readString(data, 'type') as LifecycleProductType
  if (!ALLOWED_TYPES.includes(type)) {
    throw new InvalidLifecycleEventEnvelopeError(
      `Tipo de producto no admitido: "${type}". Tipos admitidos: ${ALLOWED_TYPES.join(', ')}.`,
    )
  }

  const lifecycleStatus = readString(data, 'lifecycleStatus')
  if (lifecycleStatus !== 'ACTIVE' && lifecycleStatus !== 'SUSPENDED') {
    throw new InvalidLifecycleEventEnvelopeError(
      `El estado de ciclo de vida no es valido: "${lifecycleStatus}".`,
    )
  }

  return {
    eventId,
    eventType: eventType as CatalogLifecycleEventType,
    eventVersion: 1,
    aggregateId,
    occurredAt,
    producer: 'catalog',
    correlationId,
    data: { productId, name, type, lifecycleStatus },
  }
}
