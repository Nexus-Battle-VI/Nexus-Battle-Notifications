import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'
import type { RetryPolicy } from '../../domain/policies/RetryPolicy.js'
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
   * Resolver propietarios falló de forma transitoria (timeout, red, 5xx,
   * resolver sin configurar) o el mensaje simplemente no es válido. El
   * mensaje NO se confirma como procesado: se libera la reserva de
   * idempotencia y el consumidor debe reencolarlo mientras queden intentos
   * (ver RetryPolicy, la misma que ya usa HandleCatalogProductCreated).
   */
  Retry: 'retry',
  /** Intentos agotados: se confirma la idempotencia (mismo criterio que HandleCatalogProductCreated) y el mensaje sale del flujo hacia la cola de fallidos. */
  DeadLetter: 'dead-letter',
} as const

export type LifecycleEventOutcome =
  (typeof LifecycleEventOutcome)[keyof typeof LifecycleEventOutcome]

export interface HandleCatalogLifecycleEventResult {
  readonly outcome: LifecycleEventOutcome
  readonly eventId: string
  readonly notificationsCreated: number
  readonly attempt: number
  readonly retryDelayMs: number | null
  readonly reason: string | null
}

export interface HandleCatalogLifecycleEventDependencies {
  readonly notifications: CatalogNotificationRepositoryPort
  readonly idempotencyStore: IdempotencyStorePort
  readonly productOwnersResolver: ProductOwnersResolverPort
  readonly clock: ClockPort
  readonly retryPolicy: RetryPolicy
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

/**
 * Suspensión y reactivación se dirigen a quienes poseen el producto (llaman a
 * Player-Inventory vía `ProductOwnersResolverPort`, ver Notifications#21); el
 * resto no depende de posesión (ver CatalogNotification.NotificationAudience)
 * y por tanto no tiene ningún fallo transitorio que reintentar aquí: no
 * llaman a ningún servicio externo.
 */
const requiresOwnerResolution = (eventType: CatalogLifecycleEventType): boolean =>
  eventType === CatalogLifecycleEventType.Suspended ||
  eventType === CatalogLifecycleEventType.Reactivated

export class HandleCatalogLifecycleEvent {
  private readonly deps: HandleCatalogLifecycleEventDependencies

  constructor(deps: HandleCatalogLifecycleEventDependencies) {
    this.deps = deps
  }

  async execute(params: {
    event: CatalogLifecycleEvent
    deliveryAttempt: number
  }): Promise<HandleCatalogLifecycleEventResult> {
    const { event, deliveryAttempt } = params
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
        attempt: deliveryAttempt,
        retryDelayMs: null,
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
        attempt: deliveryAttempt,
        retryDelayMs: null,
        reason: null,
      }
    }

    const resolution = await this.deps.productOwnersResolver.resolveOwners(event.data.productId)

    if (!resolution.available) {
      // Fallo transitorio (timeout, red, 5xx) o resolver sin configurar: NO es
      // "el producto no tiene propietarios". No se confirma la idempotencia:
      // se libera para que la próxima entrega del mismo eventId pueda
      // procesarse de verdad, en vez de quedar bloqueada por una reserva que
      // nunca se completó.
      const willRetry = this.deps.retryPolicy.shouldRetry(deliveryAttempt, true)

      if (willRetry) {
        await this.deps.idempotencyStore.release(idempotencyKey)

        return {
          outcome: LifecycleEventOutcome.Retry,
          eventId: event.eventId,
          notificationsCreated: 0,
          attempt: deliveryAttempt,
          retryDelayMs: this.deps.retryPolicy.delayForAttempt(deliveryAttempt),
          reason: resolution.reason,
        }
      }

      // Intentos agotados: mismo criterio que HandleCatalogProductCreated -se
      // confirma para que una redelivery de este mismo eventId no reprocese
      // el mismo fallo indefinidamente-. Un replay manual desde la cola de
      // fallidos requiere limpiar la reserva de idempotencia explícitamente,
      // igual que ya exige el flujo de correo.
      await this.deps.idempotencyStore.confirm(idempotencyKey)

      return {
        outcome: LifecycleEventOutcome.DeadLetter,
        eventId: event.eventId,
        notificationsCreated: 0,
        attempt: deliveryAttempt,
        retryDelayMs: null,
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
      attempt: deliveryAttempt,
      retryDelayMs: null,
      reason: null,
    }
  }
}
