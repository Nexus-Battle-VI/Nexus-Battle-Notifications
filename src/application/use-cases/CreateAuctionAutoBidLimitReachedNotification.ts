import type { AuctionAutoBidLimitReachedNotification } from '../dto/AuctionAutoBidLimitReachedNotification.js'
import { AUCTION_AUTO_BID_LIMIT_REACHED_EVENT_TYPE } from '../dto/AuctionAutoBidLimitReachedNotification.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'
import type { IdempotencyStorePort } from '../ports/IdempotencyStorePort.js'
import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'
import { DomainError } from '../../domain/errors/DomainError.js'

export const AuctionAutoBidLimitReachedOutcome = {
  Created: 'created',
  Duplicated: 'duplicated',
} as const

export type AuctionAutoBidLimitReachedOutcome =
  (typeof AuctionAutoBidLimitReachedOutcome)[keyof typeof AuctionAutoBidLimitReachedOutcome]

export interface CreateAuctionAutoBidLimitReachedNotificationResult {
  readonly outcome: AuctionAutoBidLimitReachedOutcome
  readonly notificationId: string
}

export interface CreateAuctionAutoBidLimitReachedNotificationDependencies {
  readonly notifications: CatalogNotificationRepositoryPort
  readonly idempotencyStore: IdempotencyStorePort
  readonly clock: ClockPort
  readonly idempotencyTtlMs: number
}

/**
 * Registra dentro de Notifications la notificacion in-app de HU-67: la puja
 * automatica del jugador alcanzo su limite configurado y no pudo recuperar el
 * liderazgo.
 *
 * Mismo criterio que `CreateAuctionOutbidNotification` (HU-63.5): Auction ya
 * confirmo el resultado de la reaccion automatica antes de llamar aqui, asi
 * que este caso de uso no vuelve a evaluar reglas de puja.
 */
export class CreateAuctionAutoBidLimitReachedNotification {
  private readonly deps: CreateAuctionAutoBidLimitReachedNotificationDependencies

  constructor(deps: CreateAuctionAutoBidLimitReachedNotificationDependencies) {
    this.deps = deps
  }

  async execute(
    command: AuctionAutoBidLimitReachedNotification,
  ): Promise<CreateAuctionAutoBidLimitReachedNotificationResult> {
    this.validate(command)

    /*
     * El notificationId tambien es el id persistido: permite reconocer un
     * replay incluso si el proceso de Notifications fue reiniciado y el
     * IdempotencyStore en memoria ya no conserva la reserva original.
     */
    const persisted = await this.deps.notifications.findById(command.notificationId)

    if (persisted !== null) {
      return {
        outcome: AuctionAutoBidLimitReachedOutcome.Duplicated,
        notificationId: command.notificationId,
      }
    }

    const idempotencyKey = `auction:auto-bid-limit-reached:${command.notificationId}`

    const reserved = await this.deps.idempotencyStore.reserve(
      idempotencyKey,
      this.deps.idempotencyTtlMs,
    )

    if (!reserved) {
      return {
        outcome: AuctionAutoBidLimitReachedOutcome.Duplicated,
        notificationId: command.notificationId,
      }
    }

    try {
      const occurredAt = new Date(command.occurredAt)

      const notification = CatalogNotification.create({
        id: command.notificationId,
        changeType: CatalogChangeType.AuctionAutoBidLimitReached,
        description: this.description(command),
        productId: null,
        productName: null,
        implementedAt: occurredAt,
        sourceEventId: command.operationId,
        sourceEventType: AUCTION_AUTO_BID_LIMIT_REACHED_EVENT_TYPE,
        playerId: command.recipientPlayerId,
        now: this.deps.clock.now(),
      })

      await this.deps.notifications.save(notification)

      await this.deps.idempotencyStore.confirm(idempotencyKey)

      return {
        outcome: AuctionAutoBidLimitReachedOutcome.Created,
        notificationId: notification.id,
      }
    } catch (error: unknown) {
      /*
       * Puede ocurrir que el registro haya sido confirmado por otra
       * instancia de Notifications entre findById() y save().
       */
      let persistedAfterFailure: CatalogNotification | null = null

      try {
        persistedAfterFailure = await this.deps.notifications.findById(command.notificationId)
      } catch {
        /*
         * Si ni siquiera podemos consultar la persistencia, conservamos el
         * error original.
         */
      }

      if (persistedAfterFailure !== null) {
        await this.deps.idempotencyStore.confirm(idempotencyKey)

        return {
          outcome: AuctionAutoBidLimitReachedOutcome.Duplicated,
          notificationId: command.notificationId,
        }
      }

      /*
       * Si guardar falla realmente, NO confirmamos la idempotencia. Auction
       * podra reintentar el mismo notificationId cuando Notifications vuelva
       * a estar disponible.
       */
      await this.deps.idempotencyStore.release(idempotencyKey)

      throw error
    }
  }

  private description(command: AuctionAutoBidLimitReachedNotification): string {
    return (
      `Tu puja automatica en la subasta ${command.auctionId} alcanzo su limite de ` +
      `${String(command.autoBidLimitCredits)} creditos y no pudo superar la oferta lider.`
    )
  }

  private validate(command: AuctionAutoBidLimitReachedNotification): void {
    this.requireText(command.notificationId, 'notificationId')
    this.requireText(command.operationId, 'operationId')
    this.requireText(command.recipientPlayerId, 'recipientPlayerId')
    this.requireText(command.auctionId, 'auctionId')
    this.requireText(command.leadingBidderId, 'leadingBidderId')

    if (!Number.isSafeInteger(command.autoBidLimitCredits) || command.autoBidLimitCredits <= 0) {
      throw new DomainError('autoBidLimitCredits debe ser un entero positivo.')
    }

    if (
      !Number.isSafeInteger(command.requiredAmountCredits) ||
      command.requiredAmountCredits <= 0
    ) {
      throw new DomainError('requiredAmountCredits debe ser un entero positivo.')
    }

    const occurredAt = new Date(command.occurredAt)

    if (Number.isNaN(occurredAt.getTime())) {
      throw new DomainError('occurredAt debe ser una fecha ISO-8601 valida.')
    }

    if (command.recipientPlayerId === command.leadingBidderId) {
      throw new DomainError('El jugador cuyo limite se alcanzo no puede ser quien lo desplazo.')
    }
  }

  private requireText(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new DomainError(`${field} es obligatorio.`)
    }
  }
}
