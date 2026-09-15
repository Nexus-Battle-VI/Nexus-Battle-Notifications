import { CatalogNotification } from '../../domain/entities/CatalogNotification.js'
import { CatalogChangeType } from '../../domain/entities/CatalogChangeType.js'
import type { ClockPort } from '../ports/ClockPort.js'
import type { IdempotencyStorePort } from '../ports/IdempotencyStorePort.js'
import type { CatalogNotificationRepositoryPort } from '../ports/CatalogNotificationRepositoryPort.js'
import type { CatalogProductCreatedEvent } from '../dto/CatalogProductCreatedEvent.js'

export const InAppCreatedOutcome = {
  Processed: 'processed',
  Duplicated: 'duplicated',
} as const

export type InAppCreatedOutcome = (typeof InAppCreatedOutcome)[keyof typeof InAppCreatedOutcome]

export interface HandleCatalogProductCreatedInAppResult {
  readonly outcome: InAppCreatedOutcome
  readonly eventId: string
}

export interface HandleCatalogProductCreatedInAppDependencies {
  readonly notifications: CatalogNotificationRepositoryPort
  readonly idempotencyStore: IdempotencyStorePort
  readonly clock: ClockPort
  readonly idempotencyTtlMs: number
}

/**
 * Contraparte in-app de HU-38 para `catalog.product.created`.
 *
 * A propósito NO es lo mismo que `HandleCatalogProductCreated` (correo,
 * HU-33.10): esa clase no se toca ni se reutiliza aquí -ver la auditoría del
 * encargo-. Tiene su PROPIA clave de idempotencia
 * (`catalog:product:created:in-app:{eventId}`, distinta de
 * `catalog:product:created:{eventId}` que usa la ruta de correo) para que
 * ambos flujos puedan convivir sobre el mismo mensaje sin pisarse el uno al
 * otro ni duplicar la reserva.
 *
 * Un producto recién creado no tiene todavía propietarios (HU-38 no filtra
 * destinatarios para este evento; ver CA-01 del padre, donde el jugador ve la
 * creación aunque no posea el producto), así que se registra como
 * notificación GLOBAL: una única fila, no una por jugador.
 */
export class HandleCatalogProductCreatedInApp {
  private readonly deps: HandleCatalogProductCreatedInAppDependencies

  constructor(deps: HandleCatalogProductCreatedInAppDependencies) {
    this.deps = deps
  }

  async execute(
    event: CatalogProductCreatedEvent,
  ): Promise<HandleCatalogProductCreatedInAppResult> {
    const idempotencyKey = `catalog:product:created:in-app:${event.eventId}`
    const reserved = await this.deps.idempotencyStore.reserve(
      idempotencyKey,
      this.deps.idempotencyTtlMs,
    )

    if (!reserved) {
      return { outcome: InAppCreatedOutcome.Duplicated, eventId: event.eventId }
    }

    const notification = CatalogNotification.create({
      changeType: CatalogChangeType.ProductCreated,
      description: `Nuevo producto disponible: ${event.data.name}`,
      productId: event.data.productId,
      productName: event.data.name,
      implementedAt: new Date(event.occurredAt),
      sourceEventId: event.eventId,
      sourceEventType: event.eventType,
      now: this.deps.clock.now(),
    })

    await this.deps.notifications.save(notification)
    await this.deps.idempotencyStore.confirm(idempotencyKey)

    return { outcome: InAppCreatedOutcome.Processed, eventId: event.eventId }
  }
}
