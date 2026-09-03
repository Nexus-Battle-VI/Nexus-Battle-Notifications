import { randomUUID } from 'node:crypto'
import { MongoServerError, type Collection, type Db } from 'mongodb'
import {
  PurchaseConflictError,
  type PurchaseClaim,
  type PurchaseInboxPort,
} from '../../application/ports/PurchaseInboxPort.js'

interface Entry {
  readonly _id: string
  readonly orderId: string
  readonly fingerprint: string
  readonly status: 'PROCESSING' | 'SENT'
  readonly token: string
  readonly leaseUntil: Date
  readonly createdAt: Date
  readonly sentAt?: Date
}

/** Una actualizacion CAS reclama la entrega; SENT no caduca ni se purga. */
export class MongoPurchaseInbox implements PurchaseInboxPort {
  private readonly entries: Collection<Entry>
  constructor(db: Db) {
    this.entries = db.collection<Entry>('purchase_inbox')
  }

  async ensureIndexes(): Promise<void> {
    await this.entries.createIndex(
      { orderId: 1 },
      { unique: true, name: 'one_confirmation_per_order' },
    )
  }

  async claim(
    id: string,
    orderId: string,
    fingerprint: string,
    leaseMs: number,
  ): Promise<PurchaseClaim> {
    const now = new Date()
    const token = randomUUID()
    try {
      await this.entries.insertOne({
        _id: id,
        orderId,
        fingerprint,
        status: 'PROCESSING',
        token,
        leaseUntil: new Date(now.getTime() + leaseMs),
        createdAt: now,
      })
      return { status: 'CLAIMED', token }
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error
    }
    const previous = await this.entries.findOne({ _id: id })
    if (previous?.orderId !== orderId || previous.fingerprint !== fingerprint)
      throw new PurchaseConflictError()
    if (previous.status === 'SENT') return { status: 'SENT' }
    const claimed = await this.entries.findOneAndUpdate(
      { _id: id, fingerprint, status: 'PROCESSING', leaseUntil: { $lte: now } },
      { $set: { token, leaseUntil: new Date(now.getTime() + leaseMs) } },
      { returnDocument: 'after' },
    )
    return claimed === null ? { status: 'BUSY' } : { status: 'CLAIMED', token }
  }

  async renew(id: string, token: string, leaseMs: number): Promise<boolean> {
    const result = await this.entries.updateOne(
      { _id: id, token, status: 'PROCESSING' },
      { $set: { leaseUntil: new Date(Date.now() + leaseMs) } },
    )
    return result.matchedCount === 1
  }

  async markSent(id: string, token: string): Promise<boolean> {
    const result = await this.entries.updateOne(
      { _id: id, token, status: 'PROCESSING' },
      { $set: { status: 'SENT', sentAt: new Date() } },
    )
    return result.matchedCount === 1
  }

  async release(id: string, token: string): Promise<void> {
    await this.entries.updateOne(
      { _id: id, token, status: 'PROCESSING' },
      { $set: { leaseUntil: new Date(0) } },
    )
  }
}
