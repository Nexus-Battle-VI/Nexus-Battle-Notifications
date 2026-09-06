import type { Collection, Db } from 'mongodb'
import { MongoServerError } from 'mongodb'
import type { GlobalNotificationReceiptRepositoryPort } from '../../application/ports/GlobalNotificationReceiptRepositoryPort.js'

interface Document {
  readonly _id: string
  readonly playerId: string
  readonly notificationId: string
  readonly readAt: Date
}

const receiptId = (playerId: string, notificationId: string): string =>
  `${playerId}:${notificationId}`

export class MongoGlobalNotificationReceiptRepository implements GlobalNotificationReceiptRepositoryPort {
  private readonly collection: Collection<Document>

  constructor(db: Db) {
    this.collection = db.collection<Document>('global_notification_receipts')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { playerId: 1, notificationId: 1 },
      { unique: true, name: 'one_receipt_per_player_notification' },
    )
  }

  async findReadNotificationIds(
    playerId: string,
    notificationIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (notificationIds.length === 0) {
      return new Set()
    }

    const documents = await this.collection
      .find({ playerId, notificationId: { $in: [...notificationIds] } })
      .toArray()

    return new Set(documents.map((document) => document.notificationId))
  }

  async markRead(playerId: string, notificationIds: readonly string[], at: Date): Promise<void> {
    for (const notificationId of notificationIds) {
      try {
        await this.collection.insertOne({
          _id: receiptId(playerId, notificationId),
          playerId,
          notificationId,
          readAt: at,
        })
      } catch (error: unknown) {
        // Ya marcada por este jugador: idempotente, no es un error.
        if (!(error instanceof MongoServerError && error.code === 11000)) {
          throw error
        }
      }
    }
  }
}
