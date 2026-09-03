import { loadConfig } from './infrastructure/config/env.js'
import { buildApplication } from './infrastructure/bootstrap/composition-root.js'
import { createHealthServer } from './infrastructure/http/health-server.js'
import { createIngestServer } from './infrastructure/http/ingest-server.js'

const config = loadConfig(process.env)
const app = buildApplication(config)

/**
 * Estado observable del worker. Se agrupa en un objeto porque las sondas de
 * salud y los manejadores de senales lo consultan y lo modifican desde
 * contextos distintos al del bucle principal.
 */
const state = {
  running: true,
  lastPollSucceeded: true,
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

/**
 * Ingesta HTTP: el tramo Account -> Notifications (ADR-006, ingesta HTTP).
 *
 * Solo se levanta si `INGEST_ENABLED=true`. Apagado por defecto para que un
 * entorno que no lo necesita no abra un puerto que no espera.
 */
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
  app.logger.info('worker_shutdown_requested', { signal })
  ingestServer?.close()
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
  ingestEnabled: config.ingestEnabled,
  batchSize: config.batchSize,
  pollIntervalMs: config.pollIntervalMs,
})

while (state.running) {
  try {
    const summary = await app.consumer.processBatch()
    const catalogSummary = await app.catalogEventsConsumer.processBatch()
    state.lastPollSucceeded = true

    if (summary.received > 0) {
      app.logger.info('batch_processed', { ...summary })
    }
    if (catalogSummary.received > 0) {
      app.logger.info('catalog_events_batch_processed', { ...catalogSummary })
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
