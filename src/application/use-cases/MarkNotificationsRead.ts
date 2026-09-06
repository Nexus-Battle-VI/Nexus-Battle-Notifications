import { DomainError } from '../../domain/errors/DomainError.js'
import { NotificationAudience } from '../../domain/entities/CatalogNotification.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { GlobalNotificationReceiptRepositoryPort } from '../ports/GlobalNotificationReceiptRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'

export interface MarkNotificationsReadDependencies {
  readonly notifications: CatalogNotificationRepositoryPort
  readonly globalReceipts: GlobalNotificationReceiptRepositoryPort
  readonly clock: ClockPort
}

/**
 * Marca pendiente -> leída (HU-38.3). Nunca marca la notificación de otro
 * jugador: una fila PLAYER que no pertenece al `playerId` solicitante se
 * ignora en vez de mutarse -jugador A jamás puede marcar notificaciones de B-.
 * Una fila GLOBAL puede marcarla cualquiera para sí mismo: su estado de
 * lectura es por jugador.
 */
export class MarkNotificationsRead {
  private readonly deps: MarkNotificationsReadDependencies

  constructor(deps: MarkNotificationsReadDependencies) {
    this.deps = deps
  }

  async execute(playerId: string, notificationIds: readonly string[]): Promise<void> {
    if (notificationIds.length === 0) {
      throw new DomainError('Se requiere al menos un identificador de notificación.')
    }

    const now = this.deps.clock.now()
    const globalIdsToMark: string[] = []

    for (const id of notificationIds) {
      const notification = await this.deps.notifications.findById(id)

      if (notification === null) {
        continue
      }

      if (notification.audience === NotificationAudience.Global) {
        globalIdsToMark.push(notification.id)
        continue
      }

      if (notification.playerId !== playerId) {
        continue
      }

      notification.markRead(now)
      await this.deps.notifications.updateReadStatus(notification)
    }

    if (globalIdsToMark.length > 0) {
      await this.deps.globalReceipts.markRead(playerId, globalIdsToMark, now)
    }
  }
}
