export type ProductType = 'HEROE' | 'HABILIDAD' | 'ARMA' | 'ARMADURA' | 'ITEM' | 'EPICA'

export interface CatalogProductCreatedData {
  readonly productId: string
  readonly name: string
  readonly type: ProductType
  readonly lifecycleStatus: 'ACTIVE'
  readonly imageUrl: string
}

export interface CatalogProductCreatedEvent {
  readonly eventId: string
  readonly eventType: 'catalog.product.created'
  readonly eventVersion: 1
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: 'catalog'
  readonly correlationId: string
  readonly data: CatalogProductCreatedData
}
