import { describe, expect, it } from '@jest/globals'
import {
  InvalidLifecycleEventEnvelopeError,
  parseCatalogLifecycleEvent,
} from '../../../src/adapters/messaging/CatalogLifecycleEventParser.js'

const envelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  eventId: '6a1f9c3e-2b8a-4e7a-9a0f-7d3c9b2e1a44',
  eventType: 'catalog.product.suspended',
  eventVersion: 1,
  aggregateId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
  occurredAt: '2026-09-06T15:00:00Z',
  producer: 'catalog',
  correlationId: 'req-9f21ab34',
  data: {
    productId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
    name: 'Mago Hielo',
    type: 'HEROE',
    lifecycleStatus: 'SUSPENDED',
  },
  ...overrides,
})

describe('parseCatalogLifecycleEvent', () => {
  it.each([
    'catalog.product.suspended',
    'catalog.product.reactivated',
    'catalog.product.inventory.adjusted',
    'catalog.product.premium.configured',
  ])('acepta un sobre valido de %s', (eventType) => {
    const event = parseCatalogLifecycleEvent(JSON.stringify(envelope({ eventType })))

    expect(event.eventType).toBe(eventType)
    expect(event.data.productId).toBe('f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd')
  })

  it('rechaza JSON invalido', () => {
    expect(() => parseCatalogLifecycleEvent('{no-es-json')).toThrow(
      InvalidLifecycleEventEnvelopeError,
    )
  })

  it('rechaza un eventType no reconocido', () => {
    expect(() =>
      parseCatalogLifecycleEvent(
        JSON.stringify(envelope({ eventType: 'catalog.product.archived' })),
      ),
    ).toThrow(InvalidLifecycleEventEnvelopeError)
  })

  it('rechaza un eventVersion distinto de 1', () => {
    expect(() => parseCatalogLifecycleEvent(JSON.stringify(envelope({ eventVersion: 2 })))).toThrow(
      InvalidLifecycleEventEnvelopeError,
    )
  })

  it('rechaza un eventId que no es UUID', () => {
    expect(() =>
      parseCatalogLifecycleEvent(JSON.stringify(envelope({ eventId: 'no-uuid' }))),
    ).toThrow(InvalidLifecycleEventEnvelopeError)
  })

  it('rechaza cuando aggregateId no coincide con data.productId', () => {
    const body = envelope({ aggregateId: '00000000-0000-4000-8000-000000000000' })
    expect(() => parseCatalogLifecycleEvent(JSON.stringify(body))).toThrow(
      InvalidLifecycleEventEnvelopeError,
    )
  })

  it('rechaza un productor distinto de catalog', () => {
    expect(() =>
      parseCatalogLifecycleEvent(JSON.stringify(envelope({ producer: 'otro' }))),
    ).toThrow(InvalidLifecycleEventEnvelopeError)
  })

  it('rechaza un lifecycleStatus no valido', () => {
    const body = envelope({
      data: { ...(envelope()['data'] as object), lifecycleStatus: 'BORRADO' },
    })
    expect(() => parseCatalogLifecycleEvent(JSON.stringify(body))).toThrow(
      InvalidLifecycleEventEnvelopeError,
    )
  })

  it('rechaza un tipo de producto no admitido', () => {
    const body = envelope({ data: { ...(envelope()['data'] as object), type: 'DESCONOCIDO' } })
    expect(() => parseCatalogLifecycleEvent(JSON.stringify(body))).toThrow(
      InvalidLifecycleEventEnvelopeError,
    )
  })

  it('rechaza cuando falta un campo obligatorio del data', () => {
    const rest: Record<string, unknown> = { ...(envelope()['data'] as Record<string, unknown>) }
    delete rest['name']
    expect(() => parseCatalogLifecycleEvent(JSON.stringify(envelope({ data: rest })))).toThrow(
      InvalidLifecycleEventEnvelopeError,
    )
  })
})
