import type { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import type { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { GlobalNotificationReceiptRepositoryPort } from '../ports/GlobalNotificationReceiptRepositoryPort.js'

/**
 * Vista presentada al jugador: nunca expone `sourceEventId`/`sourceEventType`
 * (trazabilidad interna) ni el `playerId` de la fila.
 */
export interface PresentedNotification {
  readonly id: string
  readonly notificationIds: readonly string[]
  readonly changeType: CatalogChangeType
  readonly description: string
  readonly productId: string | null
  readonly implementedAt: string
  readonly consolidatedCount: number
}

export interface GetPlayerNotificationsDependencies {
  readonly notifications: CatalogNotificationRepositoryPort
  readonly globalReceipts: GlobalNotificationReceiptRepositoryPort
}

/** Mínimo de repeticiones sobre el mismo producto y tipo de cambio para consolidar (HU-38, CA-03: 4 cambios -> 1 entrada; no aplica a un único cambio). */
const CONSOLIDATION_THRESHOLD = 2

interface PendingItem {
  readonly notification: CatalogNotification
}

const groupKey = (item: PendingItem): string =>
  `${item.notification.productId ?? 'no-product'}:${item.notification.changeType}`

const toPresented = (items: readonly PendingItem[]): PresentedNotification => {
  const sorted = [...items].sort(
    (a, b) => b.notification.implementedAt.getTime() - a.notification.implementedAt.getTime(),
  )
  const mostRecent = sorted[0]

  if (mostRecent === undefined) {
    throw new Error('No se puede presentar un grupo vacío de notificaciones.')
  }

  if (sorted.length < CONSOLIDATION_THRESHOLD || mostRecent.notification.productId === null) {
    return {
      id: mostRecent.notification.id,
      notificationIds: [mostRecent.notification.id],
      changeType: mostRecent.notification.changeType,
      description: mostRecent.notification.description,
      productId: mostRecent.notification.productId,
      implementedAt: mostRecent.notification.implementedAt.toISOString(),
      consolidatedCount: 1,
    }
  }

  const productName = mostRecent.notification.productName ?? 'Este producto'

  return {
    id: mostRecent.notification.id,
    notificationIds: sorted.map((entry) => entry.notification.id),
    changeType: mostRecent.notification.changeType,
    description: `${productName} tuvo ${String(sorted.length)} actualizaciones recientes; ver detalle`,
    productId: mostRecent.notification.productId,
    implementedAt: mostRecent.notification.implementedAt.toISOString(),
    consolidatedCount: sorted.length,
  }
}

/**
 * Consolida por (productId, changeType): agrupar únicamente por producto
 * mezclaría, por ejemplo, una suspensión aislada con ajustes de tiraje
 * repetidos del mismo producto en una sola entrada genérica, perdiendo la
 * señal más importante de las dos. Nunca mezcla productos distintos
 * (condición explícita de HU-38).
 */
const consolidate = (items: readonly PendingItem[]): PresentedNotification[] => {
  const groups = new Map<string, PendingItem[]>()

  for (const item of items) {
    const key = groupKey(item)
    const group = groups.get(key)

    if (group === undefined) {
      groups.set(key, [item])
    } else {
      group.push(item)
    }
  }

  return [...groups.values()]
    .map(toPresented)
    .sort((a, b) => Date.parse(b.implementedAt) - Date.parse(a.implementedAt))
}

export class GetPlayerNotifications {
  private readonly deps: GetPlayerNotificationsDependencies

  constructor(deps: GetPlayerNotificationsDependencies) {
    this.deps = deps
  }

  /** Notificaciones pendientes del jugador (PLAYER propias + GLOBAL no leídas por él), consolidadas. */
  async pending(playerId: string): Promise<readonly PresentedNotification[]> {
    const playerPending = await this.deps.notifications.findPendingForPlayer(playerId)
    const globalAll = await this.deps.notifications.findGlobalSince(new Date(0))
    const globalIds = globalAll.map((notification) => notification.id)
    const readGlobalIds = await this.deps.globalReceipts.findReadNotificationIds(
      playerId,
      globalIds,
    )
    const globalPending = globalAll.filter((notification) => !readGlobalIds.has(notification.id))

    const items: PendingItem[] = [...playerPending, ...globalPending].map((notification) => ({
      notification,
    }))

    return consolidate(items)
  }

  /** Historial: PLAYER (todas) + GLOBAL ya leídas por este jugador. Más recientes primero. */
  async history(playerId: string): Promise<readonly PresentedNotification[]> {
    const playerHistory = await this.deps.notifications.findHistoryForPlayer(playerId)
    const globalAll = await this.deps.notifications.findAllGlobal()
    const globalIds = globalAll.map((notification) => notification.id)
    const readGlobalIds = await this.deps.globalReceipts.findReadNotificationIds(
      playerId,
      globalIds,
    )
    const globalRead = globalAll.filter((notification) => readGlobalIds.has(notification.id))

    return [...playerHistory, ...globalRead]
      .map((notification) => ({
        id: notification.id,
        notificationIds: [notification.id],
        changeType: notification.changeType,
        description: notification.description,
        productId: notification.productId,
        implementedAt: notification.implementedAt.toISOString(),
        consolidatedCount: 1,
      }))
      .sort((a, b) => Date.parse(b.implementedAt) - Date.parse(a.implementedAt))
  }
}
