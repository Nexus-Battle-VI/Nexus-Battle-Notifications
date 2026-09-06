/**
 * Estado de lectura por jugador de las notificaciones GLOBAL.
 *
 * Una notificación GLOBAL es una única fila compartida por todos los
 * jugadores (ver `CatalogNotification`); este puerto es lo que permite que
 * cada jugador tenga su propio "leída/pendiente" sobre esa misma fila sin
 * duplicarla ni requerir la lista completa de cuentas.
 */
export interface GlobalNotificationReceiptRepositoryPort {
  /** IDs de notificaciones GLOBAL ya leídas por este jugador. */
  findReadNotificationIds(
    playerId: string,
    notificationIds: readonly string[],
  ): Promise<ReadonlySet<string>>

  /** Marca como leídas, para este jugador, las notificaciones GLOBAL indicadas. Idempotente. */
  markRead(playerId: string, notificationIds: readonly string[], at: Date): Promise<void>
}
