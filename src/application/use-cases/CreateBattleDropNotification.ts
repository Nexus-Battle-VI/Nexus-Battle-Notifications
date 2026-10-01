import type { BattleDropNotificationCommand } from '../dto/BattleDropNotification.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'
import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'

/** Persiste una notificación dirigida solo DESPUÉS de una acreditación confirmada. */
export class CreateBattleDropNotification {
  private readonly notifications: CatalogNotificationRepositoryPort
  private readonly clock: ClockPort

  constructor(
    notifications: CatalogNotificationRepositoryPort,
    clock: ClockPort,
  ) {
    this.notifications = notifications
    this.clock = clock
  }

  async execute(command: BattleDropNotificationCommand): Promise<{ notificationId: string; outcome: 'created' | 'duplicated' }> {
    const id = `combat:drop:${command.battleId}:${String(command.defeatEventSeq)}:${command.role}:${command.recipientId}`
    const previous = await this.notifications.findById(id)
    if (previous !== null) return { notificationId: id, outcome: 'duplicated' }
    const gained = command.role === 'GAINED'
    const notification = CatalogNotification.create({
      id,
      playerId: command.recipientId,
      changeType: gained ? CatalogChangeType.BattleDropGained : CatalogChangeType.BattleDropLost,
      description: gained
        ? `Obtuviste ${command.itemId} por una derrota en Versus.`
        : `Perdiste ${command.itemId} por una derrota en Versus.`,
      productId: command.productId,
      productName: null,
      implementedAt: new Date(command.creditedAt),
      sourceEventId: `${command.battleId}:${String(command.defeatEventSeq)}`,
      sourceEventType: 'combat.drop.credited.v1',
      now: this.clock.now(),
    })
    try {
      await this.notifications.save(notification)
      return { notificationId: id, outcome: 'created' }
    } catch (error: unknown) {
      if (await this.notifications.findById(id)) {
        return { notificationId: id, outcome: 'duplicated' }
      }
      throw error
    }
  }
}
