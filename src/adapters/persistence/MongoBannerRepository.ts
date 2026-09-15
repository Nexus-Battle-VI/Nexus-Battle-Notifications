import type { Collection, Db } from 'mongodb'
import { BannerEntry, type BannerEntrySnapshot } from '../../domain/entities/BannerEntry.js'
import type { BannerRepositoryPort } from '../../application/ports/BannerRepositoryPort.js'

interface Document {
  readonly _id: string
  readonly title: string
  readonly content: string
  readonly publishAt: Date
  readonly expiresAt: Date
  readonly status: BannerEntrySnapshot['status']
  readonly createdBy: string
  readonly createdAt: Date
}

const toDocument = (entry: BannerEntry): Document => {
  const snapshot = entry.toSnapshot()

  return {
    _id: snapshot.id,
    title: snapshot.title,
    content: snapshot.content,
    publishAt: snapshot.publishAt,
    expiresAt: snapshot.expiresAt,
    status: snapshot.status,
    createdBy: snapshot.createdBy,
    createdAt: snapshot.createdAt,
  }
}

const toEntity = (document: Document): BannerEntry =>
  BannerEntry.fromSnapshot({
    id: document._id,
    title: document.title,
    content: document.content,
    publishAt: document.publishAt,
    expiresAt: document.expiresAt,
    status: document.status,
    createdBy: document.createdBy,
    createdAt: document.createdAt,
  })

export class MongoBannerRepository implements BannerRepositoryPort {
  private readonly collection: Collection<Document>

  constructor(db: Db) {
    this.collection = db.collection<Document>('banner_entries')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ publishAt: 1, expiresAt: 1 }, { name: 'validity_window' })
  }

  async save(entry: BannerEntry): Promise<void> {
    await this.collection.insertOne(toDocument(entry))
  }

  async findAll(): Promise<readonly BannerEntry[]> {
    const documents = await this.collection.find({}).sort({ createdAt: -1 }).toArray()

    return documents.map(toEntity)
  }

  async findPublishableAt(at: Date): Promise<readonly BannerEntry[]> {
    const documents = await this.collection.find({ publishAt: { $lte: at } }).toArray()

    return documents.map(toEntity)
  }
}
