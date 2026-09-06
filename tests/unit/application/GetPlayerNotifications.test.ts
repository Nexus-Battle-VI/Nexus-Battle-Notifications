import { describe, expect, it } from '@jest/globals'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { InMemoryGlobalNotificationReceiptRepository } from '../../../src/adapters/persistence/InMemoryGlobalNotificationReceiptRepository.js'
import { CatalogNotification } from '../../../src/domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../../src/domain/entities/CatalogChangeType.js'
import { GetPlayerNotifications } from '../../../src/application/use-cases/GetPlayerNotifications.js'

const at = (iso: string): Date => new Date(iso)

const playerNotification = (params: {
  playerId: string
  productId: string
  productName: string
  changeType: CatalogChangeType
  implementedAt: string
  description?: string
}): CatalogNotification =>
  CatalogNotification.create({
    changeType: params.changeType,
    description: params.description ?? `${params.productName} actualizado`,
    productId: params.productId,
    productName: params.productName,
    implementedAt: at(params.implementedAt),
    sourceEventId: `evt-${params.implementedAt}-${params.playerId}-${String(Math.random())}`,
    sourceEventType: 'catalog.product.inventory.adjusted',
    playerId: params.playerId,
    now: at(params.implementedAt),
  })

describe('GetPlayerNotifications', () => {
  it('un jugador sin notificaciones recibe una lista vacia, sin error', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()
    const useCase = new GetPlayerNotifications({ notifications, globalReceipts })

    await expect(useCase.pending('jugador-sin-notificaciones')).resolves.toEqual([])
  })

  it('CA-01: presenta cada notificacion PLAYER como entrada individual cuando no hay repeticion', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()

    await notifications.save(
      playerNotification({
        playerId: 'jugador-a',
        productId: 'mago-hielo',
        productName: 'Mago Hielo',
        changeType: CatalogChangeType.ProductSuspended,
        implementedAt: '2026-09-01T00:00:00.000Z',
        description: 'Mago Hielo fue suspendido temporalmente',
      }),
    )

    const useCase = new GetPlayerNotifications({ notifications, globalReceipts })
    const pending = await useCase.pending('jugador-a')

    expect(pending).toHaveLength(1)
    expect(pending[0]?.description).toBe('Mago Hielo fue suspendido temporalmente')
    expect(pending[0]?.consolidatedCount).toBe(1)
  })

  it('CA-03: consolida 4 modificaciones recientes del mismo producto en una sola entrada', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()

    for (let i = 0; i < 4; i += 1) {
      await notifications.save(
        playerNotification({
          playerId: 'jugador-a',
          productId: 'armadura-escamas',
          productName: 'Armadura de Escamas',
          changeType: CatalogChangeType.ProductInventoryAdjusted,
          implementedAt: `2026-09-0${String(i + 1)}T00:00:00.000Z`,
        }),
      )
    }

    const useCase = new GetPlayerNotifications({ notifications, globalReceipts })
    const pending = await useCase.pending('jugador-a')

    expect(pending).toHaveLength(1)
    expect(pending[0]?.description).toBe(
      'Armadura de Escamas tuvo 4 actualizaciones recientes; ver detalle',
    )
    expect(pending[0]?.consolidatedCount).toBe(4)
    expect(pending[0]?.notificationIds).toHaveLength(4)
  })

  it('no mezcla productos diferentes al consolidar', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()

    for (const [product, name] of [
      ['armadura-escamas', 'Armadura de Escamas'],
      ['espada-fuego', 'Espada de Fuego'],
      ['mago-hielo', 'Mago Hielo'],
    ] as const) {
      for (let i = 0; i < 2; i += 1) {
        await notifications.save(
          playerNotification({
            playerId: 'jugador-a',
            productId: product,
            productName: name,
            changeType: CatalogChangeType.ProductInventoryAdjusted,
            implementedAt: `2026-09-0${String(i + 1)}T00:00:00.000Z`,
          }),
        )
      }
    }

    const useCase = new GetPlayerNotifications({ notifications, globalReceipts })
    const pending = await useCase.pending('jugador-a')

    expect(pending).toHaveLength(3)
    const productIds = pending.map((item) => item.productId).sort()
    expect(productIds).toEqual(['armadura-escamas', 'espada-fuego', 'mago-hielo'])
  })

  it('no consolida una suspension aislada junto con ajustes de tiraje del mismo producto (distinto changeType)', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()

    await notifications.save(
      playerNotification({
        playerId: 'jugador-a',
        productId: 'mago-hielo',
        productName: 'Mago Hielo',
        changeType: CatalogChangeType.ProductSuspended,
        implementedAt: '2026-09-05T00:00:00.000Z',
        description: 'Mago Hielo fue suspendido temporalmente',
      }),
    )
    for (let i = 0; i < 2; i += 1) {
      await notifications.save(
        playerNotification({
          playerId: 'jugador-a',
          productId: 'mago-hielo',
          productName: 'Mago Hielo',
          changeType: CatalogChangeType.ProductInventoryAdjusted,
          implementedAt: `2026-09-0${String(i + 1)}T00:00:00.000Z`,
        }),
      )
    }

    const useCase = new GetPlayerNotifications({ notifications, globalReceipts })
    const pending = await useCase.pending('jugador-a')

    expect(pending).toHaveLength(2)
    const suspension = pending.find((item) => item.consolidatedCount === 1)
    expect(suspension?.description).toBe('Mago Hielo fue suspendido temporalmente')
  })

  it('aislamiento: el jugador A nunca ve notificaciones del jugador B', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()

    await notifications.save(
      playerNotification({
        playerId: 'jugador-b',
        productId: 'mago-hielo',
        productName: 'Mago Hielo',
        changeType: CatalogChangeType.ProductSuspended,
        implementedAt: '2026-09-01T00:00:00.000Z',
      }),
    )

    const useCase = new GetPlayerNotifications({ notifications, globalReceipts })

    expect(await useCase.pending('jugador-a')).toEqual([])
    expect(await useCase.pending('jugador-b')).toHaveLength(1)
  })

  it('incluye notificaciones GLOBAL no leidas en pendientes, y deja de mostrarlas tras marcarlas leidas para ese jugador', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()

    const created = CatalogNotification.create({
      changeType: CatalogChangeType.ProductCreated,
      description: 'Nuevo producto disponible: Espada de Fuego',
      productId: 'espada-fuego',
      productName: 'Espada de Fuego',
      implementedAt: at('2026-09-01T00:00:00.000Z'),
      sourceEventId: 'evt-created-1',
      sourceEventType: 'catalog.product.created',
      now: at('2026-09-01T00:00:00.000Z'),
    })
    await notifications.save(created)

    const useCase = new GetPlayerNotifications({ notifications, globalReceipts })

    const beforeA = await useCase.pending('jugador-a')
    expect(beforeA).toHaveLength(1)

    await globalReceipts.markRead('jugador-a', [created.id])

    expect(await useCase.pending('jugador-a')).toEqual([])
    // Leer no afecta a otro jugador: sigue viendola pendiente.
    expect(await useCase.pending('jugador-b')).toHaveLength(1)
  })

  it('historial: conserva las notificaciones leidas y no las presenta como pendientes', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const globalReceipts = new InMemoryGlobalNotificationReceiptRepository()

    const notification = playerNotification({
      playerId: 'jugador-a',
      productId: 'mago-hielo',
      productName: 'Mago Hielo',
      changeType: CatalogChangeType.ProductSuspended,
      implementedAt: '2026-09-01T00:00:00.000Z',
    })
    await notifications.save(notification)
    notification.markRead(at('2026-09-02T00:00:00.000Z'))
    await notifications.updateReadStatus(notification)

    const useCase = new GetPlayerNotifications({ notifications, globalReceipts })

    expect(await useCase.pending('jugador-a')).toEqual([])
    const history = await useCase.history('jugador-a')
    expect(history).toHaveLength(1)
  })
})
