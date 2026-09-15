import type { CatalogNotification } from '../../domain/entities/CatalogNotification.js'

export interface CatalogNotificationRepositoryPort {
  /** Inserta la notificación. No hace nada especial ante duplicados: la idempotencia por evento vive en `IdempotencyStorePort`. */
  save(notification: CatalogNotification): Promise<void>

  /** Notificaciones PLAYER pendientes de un jugador, más antiguas primero (orden de implementación). */
  findPendingForPlayer(playerId: string): Promise<readonly CatalogNotification[]>

  /** Historial PLAYER completo (pendientes y leídas), más recientes primero. */
  findHistoryForPlayer(playerId: string): Promise<readonly CatalogNotification[]>

  /** Notificaciones GLOBAL creadas después de `since` (exclusive), más antiguas primero. */
  findGlobalSince(since: Date): Promise<readonly CatalogNotification[]>

  /** Historial GLOBAL completo, más recientes primero. */
  findAllGlobal(): Promise<readonly CatalogNotification[]>

  findById(id: string): Promise<CatalogNotification | null>

  /** Persiste el nuevo estado de lectura de una notificación PLAYER. */
  updateReadStatus(notification: CatalogNotification): Promise<void>
}
