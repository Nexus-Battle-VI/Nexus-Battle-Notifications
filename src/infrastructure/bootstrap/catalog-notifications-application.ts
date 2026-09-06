import { MongoClient } from 'mongodb'
import type { AppConfig } from '../config/env.js'
import { QueueDriver } from '../config/env.js'
import { RetryPolicy } from '../../domain/policies/RetryPolicy.js'
import { SystemClock } from '../../adapters/clock/SystemClock.js'
import { InMemoryIdempotencyStore } from '../../adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryMessageQueue } from '../../adapters/messaging/InMemoryMessageQueue.js'
import { SqsMessageQueue } from '../../adapters/messaging/SqsMessageQueue.js'
import { CatalogLifecycleEventsConsumer } from '../../adapters/messaging/CatalogLifecycleEventsConsumer.js'
import { MongoCatalogNotificationRepository } from '../../adapters/persistence/MongoCatalogNotificationRepository.js'
import { MongoGlobalNotificationReceiptRepository } from '../../adapters/persistence/MongoGlobalNotificationReceiptRepository.js'
import { MongoBannerRepository } from '../../adapters/persistence/MongoBannerRepository.js'
import { InMemoryCatalogNotificationRepository } from '../../adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { InMemoryGlobalNotificationReceiptRepository } from '../../adapters/persistence/InMemoryGlobalNotificationReceiptRepository.js'
import { InMemoryBannerRepository } from '../../adapters/persistence/InMemoryBannerRepository.js'
import { CognitoIdentityVerifier } from '../../adapters/identity/CognitoIdentityVerifier.js'
import { UnavailableProductOwnersResolver } from '../../adapters/identity/UnavailableProductOwnersResolver.js'
import { PlayerInventoryProductOwnersResolver } from '../../adapters/identity/PlayerInventoryProductOwnersResolver.js'
import type { ProductOwnersResolverPort } from '../../application/ports/ProductOwnersResolverPort.js'
import { HandleCatalogLifecycleEvent } from '../../application/use-cases/HandleCatalogLifecycleEvent.js'
import { GetPlayerNotifications } from '../../application/use-cases/GetPlayerNotifications.js'
import { MarkNotificationsRead } from '../../application/use-cases/MarkNotificationsRead.js'
import { CreateBannerEntry } from '../../application/use-cases/CreateBannerEntry.js'
import { ListBanners } from '../../application/use-cases/ListBanners.js'
import type { CatalogNotificationRepositoryPort } from '../../application/ports/CatalogNotificationRepositoryPort.js'
import type { GlobalNotificationReceiptRepositoryPort } from '../../application/ports/GlobalNotificationReceiptRepositoryPort.js'
import type { BannerRepositoryPort } from '../../application/ports/BannerRepositoryPort.js'
import type { IdentityVerifierPort } from '../../application/ports/IdentityVerifierPort.js'
import { createCatalogNotificationsServer } from '../http/catalog-notifications-server.js'
import type { Logger } from '../observability/logger.js'

export interface CatalogNotificationsApplication {
  readonly server: ReturnType<typeof createCatalogNotificationsServer>
  readonly lifecycleEventsConsumer: CatalogLifecycleEventsConsumer
  /** Repositorio compartido con el consumidor in-app de `catalog.product.created` (ver worker.ts). */
  readonly notifications: CatalogNotificationRepositoryPort
  readonly idempotencyStore: InMemoryIdempotencyStore
  close(): Promise<void>
  ready(): Promise<boolean>
}

export const buildCatalogNotificationsApplication = async (
  config: AppConfig,
  logger: Logger,
): Promise<CatalogNotificationsApplication | null> => {
  if (config.catalogNotifications === null) {
    return null
  }

  const { catalogNotifications } = config
  const clock = new SystemClock()
  const idempotencyStore = new InMemoryIdempotencyStore(() => clock.now().getTime())

  let client: MongoClient | null = null
  let notifications: CatalogNotificationRepositoryPort
  let globalReceipts: GlobalNotificationReceiptRepositoryPort
  let banners: BannerRepositoryPort

  if (catalogNotifications.repositoryDriver === 'mongo') {
    if (catalogNotifications.mongoUrl === null) {
      throw new Error('MONGO_URL obligatorio.')
    }

    client = new MongoClient(catalogNotifications.mongoUrl, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
    })

    try {
      await client.connect()
      const db = client.db(catalogNotifications.databaseName)

      const mongoNotifications = new MongoCatalogNotificationRepository(db)
      await mongoNotifications.ensureIndexes()
      notifications = mongoNotifications

      const mongoReceipts = new MongoGlobalNotificationReceiptRepository(db)
      await mongoReceipts.ensureIndexes()
      globalReceipts = mongoReceipts

      const mongoBanners = new MongoBannerRepository(db)
      await mongoBanners.ensureIndexes()
      banners = mongoBanners
    } catch (error: unknown) {
      await client.close()
      throw error
    }
  } else {
    notifications = new InMemoryCatalogNotificationRepository()
    globalReceipts = new InMemoryGlobalNotificationReceiptRepository()
    banners = new InMemoryBannerRepository()
  }

  const identityVerifier: IdentityVerifierPort = new CognitoIdentityVerifier({
    userPoolId: catalogNotifications.cognitoUserPoolId,
    clientId: catalogNotifications.cognitoClientId,
  })

  let productOwnersResolver: ProductOwnersResolverPort
  if (catalogNotifications.playerInventory !== null) {
    productOwnersResolver = new PlayerInventoryProductOwnersResolver(
      catalogNotifications.playerInventory,
    )
    logger.info('product_owners_resolver_configured', { adapter: 'player-inventory-http' })
  } else {
    // Fail closed: sin PLAYER_INVENTORY_BASE_URL/INTERNAL_SERVICE_AUTH_SECRET
    // no se inventa un destinatario ni se cae a audiencia GLOBAL. Suspension y
    // reactivacion seguiran la misma ruta reintentable/dead-letter que
    // cualquier otro fallo de resolucion, no un ACK permanente.
    productOwnersResolver = new UnavailableProductOwnersResolver()
    logger.warn('product_owners_resolver_not_configured', {
      reason:
        'Sin PLAYER_INVENTORY_BASE_URL o INTERNAL_SERVICE_AUTH_SECRET: suspension/reactivacion se reintentaran hasta agotar intentos.',
    })
  }

  // Misma politica que ya usa HandleCatalogProductCreated (correo): no se
  // duplican maxAttempts/retryBaseDelayMs/retryMaxDelayMs con nombres nuevos.
  const retryPolicy = RetryPolicy.create({
    maxAttempts: config.maxAttempts,
    baseDelayMs: config.retryBaseDelayMs,
    maxDelayMs: config.retryMaxDelayMs,
  })

  const lifecycleUseCase = new HandleCatalogLifecycleEvent({
    notifications,
    idempotencyStore,
    productOwnersResolver,
    clock,
    retryPolicy,
    idempotencyTtlMs: config.idempotencyTtlMs,
  })

  let lifecycleQueue: InMemoryMessageQueue | SqsMessageQueue
  if (config.queueDriver === QueueDriver.Sqs && catalogNotifications.lifecycleQueueUrl !== null) {
    lifecycleQueue = new SqsMessageQueue({
      client: SqsMessageQueue.createClient(config.awsRegion ?? ''),
      queueUrl: catalogNotifications.lifecycleQueueUrl,
      deadLetterQueueUrl: config.deadLetterQueueUrl,
    })
    logger.info('catalog_lifecycle_queue_configured', { dedicated: true })
  } else {
    // Sin cola dedicada: cola en memoria propia (no la de otros consumidores),
    // para no competir por mensajes ajenos. Ver brecha de transporte en el
    // informe de entrega de HU-38 -Infrastructure no provisiona todavia una
    // cola real para estos cuatro eventos-.
    lifecycleQueue = new InMemoryMessageQueue(() => clock.now().getTime())
    logger.warn('catalog_lifecycle_queue_not_configured', {
      reason: 'Sin CATALOG_LIFECYCLE_QUEUE_URL: usando cola en memoria local, sin transporte real.',
    })
  }

  const lifecycleEventsConsumer = new CatalogLifecycleEventsConsumer({
    queue: lifecycleQueue,
    useCase: lifecycleUseCase,
    logger,
    batchSize: config.batchSize,
  })

  const getPlayerNotifications = new GetPlayerNotifications({ notifications, globalReceipts })
  const markNotificationsRead = new MarkNotificationsRead({ notifications, globalReceipts, clock })
  const createBannerEntry = new CreateBannerEntry({ banners, clock })
  const listBanners = new ListBanners({ banners, clock })

  const server = createCatalogNotificationsServer({
    port: catalogNotifications.port,
    identityVerifier,
    getPlayerNotifications,
    markNotificationsRead,
    createBannerEntry,
    listBanners,
    logger,
  })

  return {
    server,
    lifecycleEventsConsumer,
    notifications,
    idempotencyStore,
    close: async (): Promise<void> => {
      await client?.close()
    },
    ready: async (): Promise<boolean> => {
      if (client !== null) {
        await client.db(catalogNotifications.databaseName).command({ ping: 1 })
      }

      return true
    },
  }
}
