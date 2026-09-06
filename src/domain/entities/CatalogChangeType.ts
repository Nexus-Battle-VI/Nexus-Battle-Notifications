/**
 * Tipos de cambio de catálogo que HU-38 traduce a notificación in-app.
 *
 * Cada valor corresponde a un `eventType` real ya producido por Catalog
 * (HU-33 a HU-36; ver docs/contracts/catalog-events-v1.asyncapi.yaml de
 * Infrastructure). No existe un valor para "diseño" (HU-37): ese evento no
 * está implementado todavía en Catalog, así que HU-38 no puede consumirlo sin
 * inventarlo.
 */
export const CatalogChangeType = {
  ProductCreated: 'PRODUCT_CREATED',
  ProductInventoryAdjusted: 'PRODUCT_INVENTORY_ADJUSTED',
  ProductSuspended: 'PRODUCT_SUSPENDED',
  ProductReactivated: 'PRODUCT_REACTIVATED',
  ProductPremiumConfigured: 'PRODUCT_PREMIUM_CONFIGURED',
} as const

export type CatalogChangeType = (typeof CatalogChangeType)[keyof typeof CatalogChangeType]
