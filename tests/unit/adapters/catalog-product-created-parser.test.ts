import {
  InvalidEventEnvelopeError,
  parseCatalogProductCreatedEvent,
} from '../../../src/adapters/messaging/CatalogProductCreatedParser.js'

const validEvent = {
  eventId: '2b772782-8814-4c1c-b3ae-a1efca31826d',
  eventType: 'catalog.product.created',
  eventVersion: 1,
  aggregateId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
  occurredAt: '2026-09-02T20:30:00.000Z',
  producer: 'catalog',
  correlationId: 'req-6d87cfc4',
  data: {
    productId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
    name: 'Espada de Fuego',
    type: 'ARMA',
    lifecycleStatus: 'ACTIVE',
    imageUrl:
      'https://api.example.test/api/v1/catalog/product-assets/682a20f4-8375-4951-a345-842946d1de76/content',
  },
}

const serialize = (obj: unknown): string => JSON.stringify(obj)

describe('CatalogProductCreatedParser', () => {
  it('parsea un sobre valido conforme a AsyncAPI v1', () => {
    const result = parseCatalogProductCreatedEvent(serialize(validEvent))

    expect(result.eventId).toBe('2b772782-8814-4c1c-b3ae-a1efca31826d')
    expect(result.eventType).toBe('catalog.product.created')
    expect(result.eventVersion).toBe(1)
    expect(result.aggregateId).toBe('f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd')
    expect(result.occurredAt).toBe('2026-09-02T20:30:00.000Z')
    expect(result.producer).toBe('catalog')
    expect(result.correlationId).toBe('req-6d87cfc4')
    expect(result.data.name).toBe('Espada de Fuego')
    expect(result.data.type).toBe('ARMA')
    expect(result.data.lifecycleStatus).toBe('ACTIVE')
  })

  it('rechaza un cuerpo que no sea JSON valido', () => {
    expect(() => parseCatalogProductCreatedEvent('{invalido')).toThrow(
      new InvalidEventEnvelopeError('El cuerpo del mensaje no es JSON valido.'),
    )
  })

  it('rechaza un JSON que no sea un objeto', () => {
    expect(() => parseCatalogProductCreatedEvent('["array"]')).toThrow(
      new InvalidEventEnvelopeError('El sobre del evento debe ser un objeto JSON.'),
    )
  })

  it('rechaza un eventType desconocido', () => {
    const invalid = { ...validEvent, eventType: 'catalog.product.published' }
    expect(() => parseCatalogProductCreatedEvent(serialize(invalid))).toThrow(
      /Tipo de evento no reconocido: "catalog\.product\.published"/,
    )
  })

  it('rechaza un eventVersion que no sea 1 (version desconocida/no soportada)', () => {
    const version2 = { ...validEvent, eventVersion: 2 }
    expect(() => parseCatalogProductCreatedEvent(serialize(version2))).toThrow(
      new InvalidEventEnvelopeError('Version de evento no soportada: "2". Se esperaba version 1.'),
    )

    const noIntVersion = { ...validEvent, eventVersion: '1' }
    expect(() => parseCatalogProductCreatedEvent(serialize(noIntVersion))).toThrow(
      new InvalidEventEnvelopeError('El campo "eventVersion" es obligatorio y debe ser un entero.'),
    )
  })

  it('rechaza un eventId o aggregateId que no sea UUID v4', () => {
    const invalidEventId = { ...validEvent, eventId: '123-no-uuid' }
    expect(() => parseCatalogProductCreatedEvent(serialize(invalidEventId))).toThrow(
      /El campo "eventId" debe ser un UUID valido v4/,
    )

    const invalidAggId = { ...validEvent, aggregateId: 'no-uuid' }
    expect(() => parseCatalogProductCreatedEvent(serialize(invalidAggId))).toThrow(
      /El campo "aggregateId" debe ser un UUID valido v4/,
    )
  })

  it('rechaza si aggregateId no coincide con data.productId', () => {
    const mismatched = {
      ...validEvent,
      aggregateId: '00000000-0000-4000-8000-000000000000',
    }
    expect(() => parseCatalogProductCreatedEvent(serialize(mismatched))).toThrow(
      /El aggregateId ".*" no coincide con data\.productId/,
    )
  })

  it('rechaza un occurredAt que no sea fecha valida', () => {
    const invalidDate = { ...validEvent, occurredAt: 'fecha-no-valida' }
    expect(() => parseCatalogProductCreatedEvent(serialize(invalidDate))).toThrow(
      /El campo "occurredAt" debe ser una fecha ISO-8601 valida/,
    )
  })

  it('rechaza un producer distinto de "catalog"', () => {
    const invalidProducer = { ...validEvent, producer: 'commerce' }
    expect(() => parseCatalogProductCreatedEvent(serialize(invalidProducer))).toThrow(
      new InvalidEventEnvelopeError('El productor "commerce" no es valido. Se esperaba "catalog".'),
    )
  })

  it('rechaza data si no es un objeto', () => {
    const noData = { ...validEvent, data: null }
    expect(() => parseCatalogProductCreatedEvent(serialize(noData))).toThrow(
      new InvalidEventEnvelopeError('El campo "data" debe ser un objeto JSON.'),
    )
  })

  it('rechaza nombres con longitud menor a 3 o mayor a 80 caracteres', () => {
    const shortName = { ...validEvent, data: { ...validEvent.data, name: 'ab' } }
    expect(() => parseCatalogProductCreatedEvent(serialize(shortName))).toThrow(
      /El nombre del producto debe tener entre 3 y 80 caracteres/,
    )

    const longName = {
      ...validEvent,
      data: { ...validEvent.data, name: 'a'.repeat(81) },
    }
    expect(() => parseCatalogProductCreatedEvent(serialize(longName))).toThrow(
      /El nombre del producto debe tener entre 3 y 80 caracteres/,
    )
  })

  it('rechaza tipos de producto no permitidos', () => {
    const invalidType = {
      ...validEvent,
      data: { ...validEvent.data, type: 'POKEMON' },
    }
    expect(() => parseCatalogProductCreatedEvent(serialize(invalidType))).toThrow(
      /Tipo de producto no admitido: "POKEMON"/,
    )
  })

  it('rechaza lifecycleStatus distinto de ACTIVE', () => {
    const inactive = {
      ...validEvent,
      data: { ...validEvent.data, lifecycleStatus: 'ARCHIVED' },
    }
    expect(() => parseCatalogProductCreatedEvent(serialize(inactive))).toThrow(
      /El estado de ciclo de vida del producto creado debe ser "ACTIVE"/,
    )
  })
})
