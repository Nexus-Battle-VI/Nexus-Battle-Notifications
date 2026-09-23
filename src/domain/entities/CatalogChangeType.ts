/**
 * Tipos de notificacion in-app presentados al jugador.
 *
 * El nombre historico de este archivo se conserva para no romper los contratos
 * ya publicados por HU-38. Ademas de cambios de catalogo, Notifications puede
 * representar eventos dirigidos de otros contextos cuando el destinatario es
 * un jugador concreto.
 */
export const CatalogChangeType = {
  ProductCreated: 'PRODUCT_CREATED',
  ProductInventoryAdjusted: 'PRODUCT_INVENTORY_ADJUSTED',
  ProductSuspended: 'PRODUCT_SUSPENDED',
  ProductReactivated: 'PRODUCT_REACTIVATED',
  ProductPremiumConfigured: 'PRODUCT_PREMIUM_CONFIGURED',

  /**
   * HU-63 CA-05:
   * una nueva puja valida desplazo al jugador como lider de una subasta.
   */
  AuctionBidOutbid: 'AUCTION_BID_OUTBID',
  AuctionSettledSeller: 'AUCTION_SETTLED_SELLER',
  AuctionSettledWinner: 'AUCTION_SETTLED_WINNER',
  AuctionSettledLoser: 'AUCTION_SETTLED_LOSER',
  AuctionSettledWithoutBids: 'AUCTION_SETTLED_WITHOUT_BIDS',
} as const

export type CatalogChangeType = (typeof CatalogChangeType)[keyof typeof CatalogChangeType]
