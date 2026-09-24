import { loadConfig } from './infrastructure/config/env.js'
import { buildApplication } from './infrastructure/bootstrap/composition-root.js'
import { createHealthServer } from './infrastructure/http/health-server.js'
import { createIngestServer } from './infrastructure/http/ingest-server.js'
import { buildPurchaseApplication } from './infrastructure/bootstrap/purchase-application.js'
import { createPurchaseServer } from './infrastructure/http/purchase-server.js'
import { buildCatalogNotificationsApplication } from './infrastructure/bootstrap/catalog-notifications-application.js'
import { HandleCatalogProductCreatedInApp } from './application/use-cases/HandleCatalogProductCreatedInApp.js'
import { HandleCatalogProductCreatedNotifications } from './application/use-cases/HandleCatalogProductCreatedNotifications.js'
import { CreateAuctionOutbidNotification } from './application/use-cases/CreateAuctionOutbidNotification.js'
import { CatalogProductEventsConsumer } from './adapters/messaging/CatalogProductEventsConsumer.js'
import { SystemClock } from './adapters/clock/SystemClock.js'
import { createAuctionOutbidServer } from './infrastructure/http/auction-outbid-server.js'

const config = loadConfig(process.env)

const app = buildApplication(config)

const purchaseApp = await buildPurchaseApplication(config)

const purchaseServer =
  purchaseApp !== null && config.purchase !== null
    ? createPurchaseServer({
        port: config.purchase.port,
        sharedSecret: config.purchase.secret,
        useCase: purchaseApp.useCase,
        logger: app.logger,
      })
    : null

/**
 * HU-38: notificaciones in-app + banner. Subsistema opcional, igual que
 * ingesta y compras (`CATALOG_NOTIFICATIONS_HTTP_ENABLED`).
 *
 * Cuando esta activo, `catalog.product.created` gana una SEGUNDA reaccion
 * -in-app, ademas del correo heredado de HU-33.10- compuesta sobre el MISMO
 * consumidor (`app.catalogQueue`/`app.catalogUseCase`): dos consumidores
 * separados sondeando la misma cola competirian por el mismo mensaje en vez
 * de recibirlo los dos. Ver HandleCatalogProductCreatedNotifications.ts.
 */
const catalogNotificationsApp = await buildCatalogNotificationsApplication(config, app.logger)

/**
 * HU-63.5:
 * receptor interno Auction -> Notifications.
 *
 * Utiliza exactamente el mismo repositorio de notificaciones
 * dirigidas por playerId que la superficie HTTP del jugador.
 */
const auctionOutbidConfig = config.catalogNotifications?.auctionOutbid ?? null

const auctionOutbidServer =
  catalogNotificationsApp !== null && auctionOutbidConfig !== null
    ? createAuctionOutbidServer({
        port: auctionOutbidConfig.port,
        sharedSecret: auctionOutbidConfig.secret,
        useCase: new CreateAuctionOutbidNotification({
          notifications: catalogNotificationsApp.notifications,
          idempotencyStore: catalogNotificationsApp.idempotencyStore,
          clock: new SystemClock(),
          idempotencyTtlMs: config.idempotencyTtlMs,
        }),
        logger: app.logger,
      })
    : null

const catalogCreatedConsumer =
  catalogNotificationsApp === null
    ? app.catalogEventsConsumer
    : new CatalogProductEventsConsumer({
        queue: app.catalogQueue,
        logger: app.logger,
        batchSize: config.batchSize,
        useCase: new HandleCatalogProductCreatedNotifications({
          emailUseCase: app.catalogUseCase,
          inAppUseCase: new HandleCatalogProductCreatedInApp({
            notifications: catalogNotificationsApp.notifications,
            idempotencyStore: catalogNotificationsApp.idempotencyStore,
            clock: new SystemClock(),
            idempotencyTtlMs: config.idempotencyTtlMs,
          }),
        }),
      })

const state = {
  running: true,
  lastPollSucceeded: true,
  purchaseReady: true,
  catalogNotificationsReady: true,
}

const healthServer = createHealthServer({
  port: config.healthPort,

  logger: app.logger,

  version: {
    service: config.serviceName,
    version: config.version,
    nodeEnv: config.nodeEnv,
  },

  readinessChecks: [
    { name: 'consumer', check: (): boolean => state.running },
    { name: 'queue', check: (): boolean => state.lastPollSucceeded },
    ...(purchaseApp === null
      ? []
      : [{ name: 'purchase-inbox', check: (): boolean => state.purchaseReady }]),
    ...(catalogNotificationsApp === null
      ? []
      : [{ name: 'catalog-notifications', check: (): boolean => state.catalogNotificationsReady }]),
  ],

  ...(config.nodeEnv === 'development'
    ? {
        enqueue: (body: string): void => {
          if (app.inMemoryQueue) {
            app.inMemoryQueue.publish(body)

            app.logger.info('notification_enqueued')
          }
        },
      }
    : {}),
})

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

const ingestServer = config.ingestEnabled
  ? createIngestServer({
      port: config.ingestPort,

      logger: app.logger,

      publish: (body) => {
        if (app.inMemoryQueue) {
          return app.inMemoryQueue.publish(body)
        }

        throw new Error('La ingesta HTTP no esta soportada sin InMemoryMessageQueue.')
      },

      sharedSecret: config.ingestSharedSecret,
    })
  : null

const shutdown = (signal: string): void => {
  if (!state.running) {
    return
  }

  state.running = false

  app.logger.info('worker_shutdown_requested', {
    signal,
  })

  ingestServer?.close()
  auctionOutbidServer?.close()
  purchaseServer?.close(() => {
    void purchaseApp?.close().catch(() => {
      app.logger.error('purchase_inbox_close_failed')
    })
  })
  catalogNotificationsApp?.server.close(() => {
    void catalogNotificationsApp.close().catch(() => {
      app.logger.error('catalog_notifications_close_failed')
    })
  })
  healthServer.close(() => {
    app.logger.info('worker_stopped')
  })
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM')
})

process.on('SIGINT', () => {
  shutdown('SIGINT')
})

app.logger.info('worker_started', {
  emailDriver: config.emailDriver,

  queueDriver: config.queueDriver,
  catalogQueueDriver: config.catalogQueueDriver,
  catalogLifecycleQueueDriver: config.catalogNotifications?.lifecycleQueueDriver ?? null,
  ingestEnabled: config.ingestEnabled,

  auctionOutbidEnabled: auctionOutbidServer !== null,

  batchSize: config.batchSize,

  pollIntervalMs: config.pollIntervalMs,
})

while (state.running) {
  if (purchaseApp !== null) {
    try {
      state.purchaseReady = await purchaseApp.ready()
    } catch {
      state.purchaseReady = false
    }
  }
  if (catalogNotificationsApp !== null) {
    try {
      state.catalogNotificationsReady = await catalogNotificationsApp.ready()
    } catch {
      state.catalogNotificationsReady = false
    }
  }
  /**
   * DEUDA TECNICA CONOCIDA, sin resolver en esta corrección: los tres
   * consumidores (general, catalog.product.created, lifecycle) comparten un
   * unico try/catch y un unico `state.lastPollSucceeded`. Antes de separar
   * `queueDriver` de `catalogQueueDriver`, esto ya era asi -no lo introduce
   * este cambio-, pero ahora es mas consecuente: un fallo transitorio de la
   * cola GENERAL (memoria o SQS) impide que `catalogCreatedConsumer` corra
   * siquiera en esta iteracion -el `await` es secuencial dentro del mismo
   * bloque- y marca el readiness `queue` como no-listo aunque la cola dedicada
   * de Catalog (ADR-017) este perfectamente sana, y viceversa. Separar esto en
   * `generalQueueReady`/`catalogQueueReady`/`lifecycleQueueReady` con un
   * try/catch por consumidor es un cambio razonable, pero amplia el alcance de
   * esta corrección -que es desacoplar el TRANSPORTE, no la observabilidad-;
   * queda como trabajo de seguimiento, no oculto.
   */
  try {
    const summary = await app.consumer.processBatch()
    const catalogSummary = await catalogCreatedConsumer.processBatch()
    const lifecycleSummary = await catalogNotificationsApp?.lifecycleEventsConsumer.processBatch()
    const auctionSettlementSummary =
      await catalogNotificationsApp?.auctionSettlementEventsConsumer.processBatch()

    state.lastPollSucceeded = true

    if (summary.received > 0) {
      app.logger.info('batch_processed', {
        ...summary,
      })
    }

    if (catalogSummary.received > 0) {
      app.logger.info('catalog_events_batch_processed', {
        ...catalogSummary,
      })
    }

    if (lifecycleSummary !== undefined && lifecycleSummary.received > 0) {
      app.logger.info('catalog_lifecycle_events_batch_processed', {
        ...lifecycleSummary,
      })
    }

    if (auctionSettlementSummary !== undefined && auctionSettlementSummary.received > 0) {
      app.logger.info('auction_settlement_events_batch_processed', auctionSettlementSummary)
    }
  } catch (error: unknown) {
    state.lastPollSucceeded = false

    app.logger.error('batch_failed', {
      reason: error instanceof Error ? error.message : 'Fallo desconocido del lote.',
    })
  }

  app.idempotencyStore.purgeExpired()

  await sleep(config.pollIntervalMs)
}
