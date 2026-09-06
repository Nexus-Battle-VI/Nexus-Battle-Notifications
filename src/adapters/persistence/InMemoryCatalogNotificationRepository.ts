import type { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import type { CatalogNotificationRepositoryPort } from '../../application/ports/CatalogNotificationRepositoryPort.js'

/** Adaptador en memoria: desarrollo local sin Mongo y pruebas unitarias/rápidas. */
export class InMemoryCatalogNotificationRepository implements CatalogNotificationRepositoryPort {
  private readonly byId = new Map<string, CatalogNotification>()

  save(notification: CatalogNotification): Promise<void> {
    this.byId.set(notification.id, notification)

    return Promise.resolve()
  }

  findPendingForPlayer(playerId: string): Promise<readonly CatalogNotification[]> {
    const items = [...this.byId.values()]
      .filter(
        (notification) =>
          notification.audience === 'PLAYER' &&
          notification.playerId === playerId &&
          notification.readStatus === 'PENDING',
      )
      .sort((a, b) => a.implementedAt.getTime() - b.implementedAt.getTime())

    return Promise.resolve(items)
  }

  findHistoryForPlayer(playerId: string): Promise<readonly CatalogNotification[]> {
    const items = [...this.byId.values()]
      .filter(
        (notification) => notification.audience === 'PLAYER' && notification.playerId === playerId,
      )
      .sort((a, b) => b.implementedAt.getTime() - a.implementedAt.getTime())

    return Promise.resolve(items)
  }

  findGlobalSince(since: Date): Promise<readonly CatalogNotification[]> {
    const items = [...this.byId.values()]
      .filter(
        (notification) => notification.audience === 'GLOBAL' && notification.createdAt > since,
      )
      .sort((a, b) => a.implementedAt.getTime() - b.implementedAt.getTime())

    return Promise.resolve(items)
  }

  findAllGlobal(): Promise<readonly CatalogNotification[]> {
    const items = [...this.byId.values()]
      .filter((notification) => notification.audience === 'GLOBAL')
      .sort((a, b) => b.implementedAt.getTime() - a.implementedAt.getTime())

    return Promise.resolve(items)
  }

  findById(id: string): Promise<CatalogNotification | null> {
    return Promise.resolve(this.byId.get(id) ?? null)
  }

  updateReadStatus(notification: CatalogNotification): Promise<void> {
    this.byId.set(notification.id, notification)

    return Promise.resolve()
  }
}
