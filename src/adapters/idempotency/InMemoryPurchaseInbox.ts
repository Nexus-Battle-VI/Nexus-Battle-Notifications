import { randomUUID } from 'node:crypto'
import {
  PurchaseConflictError,
  type PurchaseClaim,
  type PurchaseInboxPort,
} from '../../application/ports/PurchaseInboxPort.js'

interface Entry {
  orderId: string
  fingerprint: string
  status: 'PROCESSING' | 'SENT'
  token: string
  leaseUntil: number
}

/** Solo para pruebas/desarrollo explicitos. Produccion exige Mongo. */
export class InMemoryPurchaseInbox implements PurchaseInboxPort {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number
  constructor(now: () => number = Date.now) {
    this.now = now
  }

  claim(id: string, orderId: string, fingerprint: string, leaseMs: number): Promise<PurchaseClaim> {
    const previous = this.entries.get(id)
    if (
      previous !== undefined &&
      (previous.fingerprint !== fingerprint || previous.orderId !== orderId)
    )
      return Promise.reject(new PurchaseConflictError())
    if (
      previous === undefined &&
      [...this.entries.values()].some((entry) => entry.orderId === orderId)
    )
      return Promise.reject(new PurchaseConflictError())
    if (previous?.status === 'SENT') return Promise.resolve({ status: 'SENT' })
    if (previous !== undefined && previous.leaseUntil > this.now())
      return Promise.resolve({ status: 'BUSY' })
    const token = randomUUID()
    this.entries.set(id, {
      orderId,
      fingerprint,
      status: 'PROCESSING',
      token,
      leaseUntil: this.now() + leaseMs,
    })
    return Promise.resolve({ status: 'CLAIMED', token })
  }

  renew(id: string, token: string, leaseMs: number): Promise<boolean> {
    const entry = this.entries.get(id)
    if (entry?.token !== token || entry.status !== 'PROCESSING') return Promise.resolve(false)
    entry.leaseUntil = this.now() + leaseMs
    return Promise.resolve(true)
  }

  markSent(id: string, token: string): Promise<boolean> {
    const entry = this.entries.get(id)
    if (entry?.token !== token || entry.status !== 'PROCESSING') return Promise.resolve(false)
    entry.status = 'SENT'
    return Promise.resolve(true)
  }

  release(id: string, token: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry?.token === token && entry.status === 'PROCESSING') entry.leaseUntil = 0
    return Promise.resolve()
  }
}
