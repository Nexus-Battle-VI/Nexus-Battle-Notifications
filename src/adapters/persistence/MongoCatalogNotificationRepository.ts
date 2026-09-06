import type { Collection, Db } from 'mongodb'
import {
  CatalogNotification,
  type CatalogNotificationSnapshot,
} from '../../domain/entities/CatalogNotification.js'
import type { CatalogNotificationRepositoryPort } from '../../application/ports/CatalogNotificationRepositoryPort.js'

interface Document {
  readonly _id: string
  readonly audience: CatalogNotificationSnapshot['audience']
  readonly playerId: string | null
  readonly changeType: CatalogNotificationSnapshot['changeType']
  readonly description: string
  readonly productId: string | null
  readonly productName: string | null
  readonly implementedAt: Date
  readonly readStatus: CatalogNotificationSnapshot['readStatus']
  readonly readAt: Date | null
  readonly sourceEventId: string
  readonly sourceEventType: string
  readonly createdAt: Date
}

const toDocument = (notification: CatalogNotification): Document => {
  const snapshot = notification.toSnapshot()

  return {
    _id: snapshot.id,
    audience: snapshot.audience,
    playerId: snapshot.playerId,
    changeType: snapshot.changeType,
    description: snapshot.description,
    productId: snapshot.productId,
    productName: snapshot.productName,
    implementedAt: snapshot.implementedAt,
    readStatus: snapshot.readStatus,
    readAt: snapshot.readAt,
    sourceEventId: snapshot.sourceEventId,
    sourceEventType: snapshot.sourceEventType,
    createdAt: snapshot.createdAt,
  }
}

const toEntity = (document: Document): CatalogNotification =>
  CatalogNotification.fromSnapshot({
    id: document._id,
    audience: document.audience,
    playerId: document.playerId,
    changeType: document.changeType,
    description: document.description,
    productId: document.productId,
    productName: document.productName,
    implementedAt: document.implementedAt,
    readStatus: document.readStatus,
    readAt: document.readAt,
    sourceEventId: document.sourceEventId,
    sourceEventType: document.sourceEventType,
    createdAt: document.createdAt,
  })

export class MongoCatalogNotificationRepository implements CatalogNotificationRepositoryPort {
  private readonly collection: Collection<Document>

  constructor(db: Db) {
    this.collection = db.collection<Document>('catalog_notifications')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { playerId: 1, readStatus: 1, implementedAt: 1 },
      { name: 'player_pending_by_date' },
    )
    await this.collection.createIndex(
      { audience: 1, createdAt: 1 },
      { name: 'global_by_created_at' },
    )
    await this.collection.createIndex(
      { sourceEventId: 1, sourceEventType: 1 },
      { name: 'source_event_lookup' },
    )
  }

  async save(notification: CatalogNotification): Promise<void> {
    await this.collection.insertOne(toDocument(notification))
  }

  async findPendingForPlayer(playerId: string): Promise<readonly CatalogNotification[]> {
    const documents = await this.collection
      .find({ audience: 'PLAYER', playerId, readStatus: 'PENDING' })
      .sort({ implementedAt: 1 })
      .toArray()

    return documents.map(toEntity)
  }

  async findHistoryForPlayer(playerId: string): Promise<readonly CatalogNotification[]> {
    const documents = await this.collection
      .find({ audience: 'PLAYER', playerId })
      .sort({ implementedAt: -1 })
      .toArray()

    return documents.map(toEntity)
  }

  async findGlobalSince(since: Date): Promise<readonly CatalogNotification[]> {
    const documents = await this.collection
      .find({ audience: 'GLOBAL', createdAt: { $gt: since } })
      .sort({ implementedAt: 1 })
      .toArray()

    return documents.map(toEntity)
  }

  async findAllGlobal(): Promise<readonly CatalogNotification[]> {
    const documents = await this.collection
      .find({ audience: 'GLOBAL' })
      .sort({ implementedAt: -1 })
      .toArray()

    return documents.map(toEntity)
  }

  async findById(id: string): Promise<CatalogNotification | null> {
    const document = await this.collection.findOne({ _id: id })

    return document === null ? null : toEntity(document)
  }

  async updateReadStatus(notification: CatalogNotification): Promise<void> {
    const snapshot = notification.toSnapshot()
    await this.collection.updateOne(
      { _id: snapshot.id },
      { $set: { readStatus: snapshot.readStatus, readAt: snapshot.readAt } },
    )
  }
}
