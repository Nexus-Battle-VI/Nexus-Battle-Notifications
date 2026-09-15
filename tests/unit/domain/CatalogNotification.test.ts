import { describe, expect, it } from '@jest/globals'
import { CatalogNotification } from '../../../src/domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../../src/domain/entities/CatalogChangeType.js'
import { DomainError } from '../../../src/domain/errors/DomainError.js'

const NOW = new Date('2026-09-06T12:00:00.000Z')

describe('CatalogNotification', () => {
  it('crea una notificacion PLAYER asociada a un producto y conserva sus datos', () => {
    const notification = CatalogNotification.create({
      changeType: CatalogChangeType.ProductSuspended,
      description: 'Mago Hielo fue suspendido temporalmente',
      productId: 'prod-1',
      productName: 'Mago Hielo',
      implementedAt: NOW,
      sourceEventId: 'evt-1',
      sourceEventType: 'catalog.product.suspended',
      playerId: 'jugador-a',
      now: NOW,
    })

    const snapshot = notification.toSnapshot()
    expect(snapshot.audience).toBe('PLAYER')
    expect(snapshot.playerId).toBe('jugador-a')
    expect(snapshot.productId).toBe('prod-1')
    expect(snapshot.changeType).toBe(CatalogChangeType.ProductSuspended)
    expect(snapshot.description).toBe('Mago Hielo fue suspendido temporalmente')
    expect(snapshot.implementedAt).toEqual(NOW)
    expect(snapshot.readStatus).toBe('PENDING')
  })

  it('crea una notificacion GLOBAL sin producto asociado cuando corresponde a un evento sin producto', () => {
    const notification = CatalogNotification.create({
      changeType: CatalogChangeType.ProductCreated,
      description: 'Nuevo producto disponible: Espada de Fuego',
      implementedAt: NOW,
      sourceEventId: 'evt-2',
      sourceEventType: 'catalog.product.created',
      now: NOW,
    })

    expect(notification.audience).toBe('GLOBAL')
    expect(notification.playerId).toBeNull()
    expect(notification.productId).toBeNull()
  })

  it('pasa de pendiente a leida', () => {
    const notification = CatalogNotification.create({
      changeType: CatalogChangeType.ProductReactivated,
      description: 'Guerrero Tanque fue reactivado y vuelve a estar disponible',
      productId: 'prod-2',
      productName: 'Guerrero Tanque',
      implementedAt: NOW,
      sourceEventId: 'evt-3',
      sourceEventType: 'catalog.product.reactivated',
      playerId: 'jugador-a',
      now: NOW,
    })

    expect(notification.readStatus).toBe('PENDING')

    const readAt = new Date('2026-09-06T13:00:00.000Z')
    notification.markRead(readAt)

    expect(notification.readStatus).toBe('READ')
    expect(notification.readAt).toEqual(readAt)
  })

  it('marcar como leida es idempotente: no sobrescribe la primera fecha de lectura', () => {
    const notification = CatalogNotification.create({
      changeType: CatalogChangeType.ProductReactivated,
      description: 'x',
      implementedAt: NOW,
      sourceEventId: 'evt-4',
      sourceEventType: 'catalog.product.reactivated',
      playerId: 'jugador-a',
      now: NOW,
    })

    const firstRead = new Date('2026-09-06T13:00:00.000Z')
    notification.markRead(firstRead)
    notification.markRead(new Date('2026-09-07T00:00:00.000Z'))

    expect(notification.readAt).toEqual(firstRead)
  })

  it('rechaza marcar como leida una notificacion GLOBAL: su estado de lectura vive en el receipt, no en la fila', () => {
    const notification = CatalogNotification.create({
      changeType: CatalogChangeType.ProductCreated,
      description: 'x',
      implementedAt: NOW,
      sourceEventId: 'evt-5',
      sourceEventType: 'catalog.product.created',
      now: NOW,
    })

    expect(() => {
      notification.markRead(NOW)
    }).toThrow(DomainError)
  })

  it('rechaza una descripcion vacia', () => {
    expect(() =>
      CatalogNotification.create({
        changeType: CatalogChangeType.ProductCreated,
        description: '   ',
        implementedAt: NOW,
        sourceEventId: 'evt-6',
        sourceEventType: 'catalog.product.created',
        now: NOW,
      }),
    ).toThrow(DomainError)
  })

  it('reconstruye desde snapshot preservando estado de lectura', () => {
    const original = CatalogNotification.create({
      changeType: CatalogChangeType.ProductSuspended,
      description: 'x',
      productId: 'prod-3',
      implementedAt: NOW,
      sourceEventId: 'evt-7',
      sourceEventType: 'catalog.product.suspended',
      playerId: 'jugador-b',
      now: NOW,
    })

    const rebuilt = CatalogNotification.fromSnapshot(original.toSnapshot())

    expect(rebuilt.toSnapshot()).toEqual(original.toSnapshot())
  })
})
