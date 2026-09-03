import { MongoClient } from 'mongodb'
import { InMemoryPurchaseInbox } from '../../adapters/idempotency/InMemoryPurchaseInbox.js'
import { MongoPurchaseInbox } from '../../adapters/idempotency/MongoPurchaseInbox.js'
import { InMemoryTemplateRenderer } from '../../adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../adapters/templates/default-templates.js'
import { SendPurchaseConfirmation } from '../../application/use-cases/SendPurchaseConfirmation.js'
import type { PurchaseInboxPort } from '../../application/ports/PurchaseInboxPort.js'
import type { AppConfig } from '../config/env.js'
import { buildEmailSender } from './composition-root.js'

interface PurchaseApplication {
  readonly useCase: SendPurchaseConfirmation
  close(): Promise<void>
  ready(): Promise<boolean>
}

export const buildPurchaseApplication = async (
  config: AppConfig,
): Promise<PurchaseApplication | null> => {
  if (config.purchase === null) return null
  const { purchase } = config
  let client: MongoClient | null = null
  let inbox: PurchaseInboxPort
  if (purchase.inboxDriver === 'mongo') {
    if (purchase.mongoUrl === null) throw new Error('MONGO_URL obligatorio.')
    client = new MongoClient(purchase.mongoUrl, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000 })
    try {
      await client.connect()
      const mongoInbox = new MongoPurchaseInbox(client.db(purchase.databaseName))
      await mongoInbox.ensureIndexes()
      inbox = mongoInbox
    } catch (error: unknown) {
      await client.close()
      throw error
    }
  } else {
    inbox = new InMemoryPurchaseInbox()
  }
  return {
    useCase: new SendPurchaseConfirmation({
      inbox,
      emailSender: buildEmailSender(config),
      templates: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
    }),
    close: async (): Promise<void> => {
      await client?.close()
    },
    ready: async (): Promise<boolean> => {
      if (client !== null) await client.db(purchase.databaseName).command({ ping: 1 })
      return true
    },
  }
}
