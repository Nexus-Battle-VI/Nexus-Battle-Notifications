import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'
import type { ClockPort } from '../ports/ClockPort.js'
import type { IdempotencyStorePort } from '../ports/IdempotencyStorePort.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { ProductOwnersResolverPort } from '../ports/ProductOwnersResolverPort.js'
import {
  CatalogLifecycleEventType,
  type CatalogLifecycleEvent,
} from '../dto/CatalogLifecycleEvent.js'

export const LifecycleEventOutcome = {
  Processed: 'processed',
  Duplicated: 'duplicated',
  /**
   * El evento es válido pero requiere resolver propietarios y ese contrato no
   * existe todavía (ver ProductOwnersResolverPort). Se confirma como procesado
   * -no se reintenta ni se manda a la cola de fallidos-: no es un error
   * transitorio del mensaje, es una brecha de contrato que un reintento no
   * resuelve. Queda registrado para trazabilidad y para un backfill futuro.
   */
  RecipientsUnresolved: 'recipients-unresolved',
} as const

export type LifecycleEventOutcome =
  (typeof LifecycleEventOutcome)[keyof typeof LifecycleEventOutcome]

export interface HandleCatalogLifecycleEventResult {
  readonly outcome: LifecycleEventOutcome
  readonly eventId: string
  readonly notificationsCreated: number
  readonly reason: string | null
}

export interface HandleCatalogLifecycleEventDependencies {
  readonly notifications: CatalogNotificationRepositoryPort
  readonly idempotencyStore: IdempotencyStorePort
  readonly productOwnersResolver: ProductOwnersResolverPort
  readonly clock: ClockPort
  readonly idempotencyTtlMs: number
}

const CHANGE_TYPE_BY_EVENT_TYPE: Record<CatalogLifecycleEventType, CatalogChangeType> = {
  [CatalogLifecycleEventType.Suspended]: CatalogChangeType.ProductSuspended,
  [CatalogLifecycleEventType.Reactivated]: CatalogChangeType.ProductReactivated,
  [CatalogLifecycleEventType.InventoryAdjusted]: CatalogChangeType.ProductInventoryAdjusted,
  [CatalogLifecycleEventType.PremiumConfigured]: CatalogChangeType.ProductPremiumConfigured,
}

/**
 * Traduce el evento a lenguaje de jugador. Nunca incluye productId, nombres de
 * servicio, colas ni estructuras técnicas (HU-38.2).
 */
const describe = (eventType: CatalogLifecycleEventType, productName: string): string => {
  switch (eventType) {
    case CatalogLifecycleEventType.Suspended:
      return `${productName} fue suspendido temporalmente`
    case CatalogLifecycleEventType.Reactivated:
      return `${productName} fue reactivado y vuelve a estar disponible`
    case CatalogLifecycleEventType.InventoryAdjusted:
      return `${productName} fue actualizado`
    case CatalogLifecycleEventType.PremiumConfigured:
      return `La condición Premium de ${productName} fue actualizada`
  }
}

/** Suspensión y reactivación se dirigen a quienes poseen el producto; el resto no depende de posesión (ver CatalogNotification.NotificationAudience). */
const requiresOwnerResolution = (eventType: CatalogLifecycleEventType): boolean =>
  eventType === CatalogLifecycleEventType.Suspended ||
  eventType === CatalogLifecycleEventType.Reactivated

export class HandleCatalogLifecycleEvent {
  private readonly deps: HandleCatalogLifecycleEventDependencies

  constructor(deps: HandleCatalogLifecycleEventDependencies) {
    this.deps = deps
  }

  async execute(event: CatalogLifecycleEvent): Promise<HandleCatalogLifecycleEventResult> {
    const idempotencyKey = `catalog:lifecycle:${event.eventType}:${event.eventId}`
    const reserved = await this.deps.idempotencyStore.reserve(
      idempotencyKey,
      this.deps.idempotencyTtlMs,
    )

    if (!reserved) {
      return {
        outcome: LifecycleEventOutcome.Duplicated,
        eventId: event.eventId,
        notificationsCreated: 0,
        reason: `El evento "${event.eventId}" ya fue procesado previamente.`,
      }
    }

    const changeType = CHANGE_TYPE_BY_EVENT_TYPE[event.eventType]
    const description = describe(event.eventType, event.data.name)
    const implementedAt = new Date(event.occurredAt)
    const now = this.deps.clock.now()

    if (!requiresOwnerResolution(event.eventType)) {
      const notification = CatalogNotification.create({
        changeType,
        description,
        productId: event.data.productId,
        productName: event.data.name,
        implementedAt,
        sourceEventId: event.eventId,
        sourceEventType: event.eventType,
        now,
      })

      await this.deps.notifications.save(notification)
      await this.deps.idempotencyStore.confirm(idempotencyKey)

      return {
        outcome: LifecycleEventOutcome.Processed,
        eventId: event.eventId,
        notificationsCreated: 1,
        reason: null,
      }
    }

    const resolution = await this.deps.productOwnersResolver.resolveOwners(event.data.productId)

    if (!resolution.available) {
      await this.deps.idempotencyStore.confirm(idempotencyKey)

      return {
        outcome: LifecycleEventOutcome.RecipientsUnresolved,
        eventId: event.eventId,
        notificationsCreated: 0,
        reason: resolution.reason,
      }
    }

    for (const playerId of resolution.playerIds) {
      const notification = CatalogNotification.create({
        changeType,
        description,
        productId: event.data.productId,
        productName: event.data.name,
        implementedAt,
        sourceEventId: event.eventId,
        sourceEventType: event.eventType,
        playerId,
        now,
      })

      await this.deps.notifications.save(notification)
    }

    await this.deps.idempotencyStore.confirm(idempotencyKey)

    return {
      outcome: LifecycleEventOutcome.Processed,
      eventId: event.eventId,
      notificationsCreated: resolution.playerIds.length,
      reason: null,
    }
  }
}
