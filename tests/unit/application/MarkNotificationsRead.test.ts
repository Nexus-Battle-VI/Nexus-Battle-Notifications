import { describe, expect, it } from '@jest/globals'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { InMemoryGlobalNotificationReceiptRepository } from '../../../src/adapters/persistence/InMemoryGlobalNotificationReceiptRepository.js'
import { CatalogNotification } from '../../../src/domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../../src/domain/entities/CatalogChangeType.js'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
import { MarkNotificationsRead } from '../../../src/application/use-cases/MarkNotificationsRead.js'
import { GetPlayerNotifications } from '../../../src/application/use-cases/GetPlayerNotifications.js'
import { DomainError } from '../../../src/domain/errors/DomainError.js'

const NOW = new Date('2026-09-06T00:00:00.000Z')

describe('MarkNotificationsRead', () => {
  it('presentar y marcar: pendiente -> leida, y deja de aparecer entre pendientes en el siguiente inicio de sesion', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()

    const notification = CatalogNotification.create({
      changeType: CatalogChangeType.ProductSuspended,
      description: 'Mago Hielo fue suspendido temporalmente',
      productId: 'mago-hielo',
      implementedAt: NOW,
      sourceEventId: 'evt-1',
      sourceEventType: 'catalog.product.suspended',
      playerId: 'jugador-a',
      now: NOW,
    })
    await notifications.save(notification)

    const markRead = new MarkNotificationsRead({
      notifications,
      globalReceipts,
      clock: new SystemClock(),
    })
    await markRead.execute('jugador-a', [notification.id])

    const persisted = await notifications.findById(notification.id)
    expect(persisted?.readStatus).toBe('READ')
    expect(persisted?.readAt).not.toBeNull()

    const getNotifications = new GetPlayerNotifications({ notifications, globalReceipts })
    expect(await getNotifications.pending('jugador-a')).toEqual([])
    expect(await getNotifications.history('jugador-a')).toHaveLength(1)
  })

  it('jugador A jamas puede marcar como leida una notificacion de B', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()

    const notification = CatalogNotification.create({
      changeType: CatalogChangeType.ProductSuspended,
      description: 'x',
      productId: 'mago-hielo',
      implementedAt: NOW,
      sourceEventId: 'evt-1',
      sourceEventType: 'catalog.product.suspended',
      playerId: 'jugador-b',
      now: NOW,
    })
    await notifications.save(notification)

    const markRead = new MarkNotificationsRead({
      notifications,
      globalReceipts,
      clock: new SystemClock(),
    })
    await markRead.execute('jugador-a', [notification.id])

    const persisted = await notifications.findById(notification.id)
    expect(persisted?.readStatus).toBe('PENDING')
  })

  it('marca una notificacion GLOBAL como leida unicamente para el jugador solicitante', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()

    const notification = CatalogNotification.create({
      changeType: CatalogChangeType.ProductCreated,
      description: 'Nuevo producto disponible: Espada de Fuego',
      implementedAt: NOW,
      sourceEventId: 'evt-2',
      sourceEventType: 'catalog.product.created',
      now: NOW,
    })
    await notifications.save(notification)

    const markRead = new MarkNotificationsRead({
      notifications,
      globalReceipts,
      clock: new SystemClock(),
    })
    await markRead.execute('jugador-a', [notification.id])

    const readByA = await globalReceipts.findReadNotificationIds('jugador-a', [notification.id])
    const readByB = await globalReceipts.findReadNotificationIds('jugador-b', [notification.id])
    expect(readByA.has(notification.id)).toBe(true)
    expect(readByB.has(notification.id)).toBe(false)
  })

  it('un identificador inexistente se ignora sin error', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()
    const markRead = new MarkNotificationsRead({
      notifications,
      globalReceipts,
      clock: new SystemClock(),
    })

    await expect(markRead.execute('jugador-a', ['no-existe'])).resolves.toBeUndefined()
  })

  it('rechaza una lista vacia de identificadores', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()
    const markRead = new MarkNotificationsRead({
      notifications,
      globalReceipts,
      clock: new SystemClock(),
    })

    await expect(markRead.execute('jugador-a', [])).rejects.toThrow(DomainError)
  })
})
