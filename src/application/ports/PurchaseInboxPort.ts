export type PurchaseClaim =
  { readonly status: 'SENT' | 'BUSY' } | { readonly status: 'CLAIMED'; readonly token: string }

export class PurchaseConflictError extends Error {
  constructor() {
    super('La compra o notificacion ya esta registrada con otros datos.')
    this.name = 'PurchaseConflictError'
  }
}

export class PurchasePendingError extends Error {
  constructor() {
    super('La entrega sigue pendiente. Reintente la misma notificacion.')
    this.name = 'PurchasePendingError'
  }
}

export interface PurchaseInboxPort {
  claim(
    notificationId: string,
    orderId: string,
    fingerprint: string,
    leaseMs: number,
  ): Promise<PurchaseClaim>
  renew(notificationId: string, token: string, leaseMs: number): Promise<boolean>
  markSent(notificationId: string, token: string): Promise<boolean>
  release(notificationId: string, token: string): Promise<void>
}
