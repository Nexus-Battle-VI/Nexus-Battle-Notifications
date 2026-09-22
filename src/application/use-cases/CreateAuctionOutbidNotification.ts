import type { AuctionBidOutbidNotification } from '../dto/AuctionBidOutbidNotification.js'
import { AUCTION_BID_OUTBID_EVENT_TYPE } from '../dto/AuctionBidOutbidNotification.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'
import type { IdempotencyStorePort } from '../ports/IdempotencyStorePort.js'
import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'
import { DomainError } from '../../domain/errors/DomainError.js'

export const AuctionOutbidNotificationOutcome = {
  Created: 'created',
  Duplicated: 'duplicated',
} as const

export type AuctionOutbidNotificationOutcome =
  (typeof AuctionOutbidNotificationOutcome)[keyof typeof AuctionOutbidNotificationOutcome]

export interface CreateAuctionOutbidNotificationResult {
  readonly outcome: AuctionOutbidNotificationOutcome
  readonly notificationId: string
}

export interface CreateAuctionOutbidNotificationDependencies {
  readonly notifications: CatalogNotificationRepositoryPort
  readonly idempotencyStore: IdempotencyStorePort
  readonly clock: ClockPort
  readonly idempotencyTtlMs: number
}

/**
 * Registra dentro de Notifications la notificacion in-app de una puja
 * superada.
 *
 * Auction solo puede llamar este caso de uso despues de que:
 *
 * 1. la nueva puja haya quedado persistida como lider;
 * 2. se haya liberado la reserva del lider anterior;
 * 3. la operacion de creditos haya terminado en COMPLETED.
 *
 * Este caso de uso no conoce Wallet ni reglas de puja. Su responsabilidad
 * empieza cuando Auction ya confirmo el resultado.
 */
export class CreateAuctionOutbidNotification {
  private readonly deps: CreateAuctionOutbidNotificationDependencies

  constructor(deps: CreateAuctionOutbidNotificationDependencies) {
    this.deps = deps
  }

  async execute(
    command: AuctionBidOutbidNotification,
  ): Promise<CreateAuctionOutbidNotificationResult> {
    this.validate(command)

    /*
     * El notificationId tambien es el id persistido.
     *
     * Esto permite reconocer un replay incluso si el proceso de
     * Notifications fue reiniciado y el IdempotencyStore en memoria
     * ya no conserva la reserva original.
     */
    const persisted = await this.deps.notifications.findById(command.notificationId)

    if (persisted !== null) {
      return {
        outcome: AuctionOutbidNotificationOutcome.Duplicated,
        notificationId: command.notificationId,
      }
    }

    const idempotencyKey = `auction:outbid:${command.notificationId}`

    const reserved = await this.deps.idempotencyStore.reserve(
      idempotencyKey,
      this.deps.idempotencyTtlMs,
    )

    if (!reserved) {
      return {
        outcome: AuctionOutbidNotificationOutcome.Duplicated,
        notificationId: command.notificationId,
      }
    }

    try {
      const occurredAt = new Date(command.occurredAt)

      const notification = CatalogNotification.create({
        id: command.notificationId,
        changeType: CatalogChangeType.AuctionBidOutbid,
        description: this.description(command),
        productId: null,
        productName: null,
        implementedAt: occurredAt,
        sourceEventId: command.operationId,
        sourceEventType: AUCTION_BID_OUTBID_EVENT_TYPE,
        playerId: command.recipientPlayerId,
        now: this.deps.clock.now(),
      })

      await this.deps.notifications.save(notification)

      await this.deps.idempotencyStore.confirm(idempotencyKey)

      return {
        outcome: AuctionOutbidNotificationOutcome.Created,
        notificationId: notification.id,
      }
    } catch (error: unknown) {
      /*
       * Puede ocurrir que el registro haya sido confirmado por otra
       * instancia de Notifications entre findById() y save().
       *
       * Comprobamos de nuevo antes de devolver 503 para que una
       * carrera entre instancias siga siendo idempotente.
       */
      let persistedAfterFailure: CatalogNotification | null = null

      try {
        persistedAfterFailure = await this.deps.notifications.findById(command.notificationId)
      } catch {
        /*
         * Si ni siquiera podemos consultar la persistencia,
         * conservamos el error original.
         */
      }

      if (persistedAfterFailure !== null) {
        await this.deps.idempotencyStore.confirm(idempotencyKey)

        return {
          outcome: AuctionOutbidNotificationOutcome.Duplicated,
          notificationId: command.notificationId,
        }
      }

      /*
       * Si guardar falla realmente, NO confirmamos la idempotencia.
       * Auction podra reintentar el mismo notificationId cuando
       * Notifications vuelva a estar disponible.
       */
      await this.deps.idempotencyStore.release(idempotencyKey)

      throw error
    }
  }

  private description(command: AuctionBidOutbidNotification): string {
    return (
      `Tu puja en la subasta ${command.auctionId} ` +
      'fue superada. ' +
      `La nueva oferta lider es de ${String(command.winningAmountCredits)} creditos.`
    )
  }

  private validate(command: AuctionBidOutbidNotification): void {
    this.requireText(command.notificationId, 'notificationId')

    this.requireText(command.operationId, 'operationId')

    this.requireText(command.recipientPlayerId, 'recipientPlayerId')

    this.requireText(command.auctionId, 'auctionId')

    this.requireText(command.outbidBidId, 'outbidBidId')

    this.requireText(command.winningBidId, 'winningBidId')

    this.requireText(command.winningBidderId, 'winningBidderId')

    if (!Number.isSafeInteger(command.winningAmountCredits) || command.winningAmountCredits <= 0) {
      throw new DomainError('winningAmountCredits debe ser un entero positivo.')
    }

    const occurredAt = new Date(command.occurredAt)

    if (Number.isNaN(occurredAt.getTime())) {
      throw new DomainError('occurredAt debe ser una fecha ISO-8601 valida.')
    }

    if (command.recipientPlayerId === command.winningBidderId) {
      throw new DomainError('El jugador desplazado no puede ser el nuevo lider.')
    }
  }

  private requireText(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new DomainError(`${field} es obligatorio.`)
    }
  }
}
