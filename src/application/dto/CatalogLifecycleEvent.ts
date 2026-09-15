/**
 * Envelope y payload de los eventos de catálogo distintos de
 * `catalog.product.created` (que ya tiene su propio DTO/parser desde
 * HU-33.10). Cubre exactamente los `eventType` que Catalog #49/#48/HU-34
 * escriben hoy en su outbox -verificado en código, no supuesto-:
 *
 * - catalog.product.suspended
 * - catalog.product.reactivated
 * - catalog.product.inventory.adjusted
 * - catalog.product.premium.configured
 *
 * Los cuatro comparten el mismo envelope (eventId/eventType/eventVersion/
 * aggregateId/occurredAt/producer/correlationId/data) y el mismo `data`: el
 * snapshot completo de `CanonicalProductDto` -tal como Catalog lo escribe
 * literalmente en el outbox-, sin el campo `reason` de la suspensión/
 * reactivación, que solo vive en `audit_log` de Catalog, no en el evento.
 */
export const CatalogLifecycleEventType = {
  Suspended: 'catalog.product.suspended',
  Reactivated: 'catalog.product.reactivated',
  InventoryAdjusted: 'catalog.product.inventory.adjusted',
  PremiumConfigured: 'catalog.product.premium.configured',
} as const

export type CatalogLifecycleEventType =
  (typeof CatalogLifecycleEventType)[keyof typeof CatalogLifecycleEventType]

export type LifecycleProductType = 'HEROE' | 'HABILIDAD' | 'ARMA' | 'ARMADURA' | 'ITEM' | 'EPICA'

export interface CatalogLifecycleEventData {
  readonly productId: string
  readonly name: string
  readonly type: LifecycleProductType
  readonly lifecycleStatus: 'ACTIVE' | 'SUSPENDED'
}

export interface CatalogLifecycleEvent {
  readonly eventId: string
  readonly eventType: CatalogLifecycleEventType
  readonly eventVersion: 1
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: 'catalog'
  readonly correlationId: string
  readonly data: CatalogLifecycleEventData
}
