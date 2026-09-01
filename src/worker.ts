import { loadConfig } from './infrastructure/config/env.js'
import { buildApplication } from './infrastructure/bootstrap/composition-root.js'
import { createHealthServer } from './infrastructure/http/health-server.js'

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
          app.queue.publish(body)
          app.logger.info('notification_enqueued')
        },
      }
    : {}),
})

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

const shutdown = (signal: string): void => {
  if (!state.running) {
    return
  }

  state.running = false
  app.logger.info('worker_shutdown_requested', { signal })
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
  batchSize: config.batchSize,
  pollIntervalMs: config.pollIntervalMs,
})

while (state.running) {
  try {
    const summary = await app.consumer.processBatch()
    state.lastPollSucceeded = true

    if (summary.received > 0) {
      app.logger.info('batch_processed', { ...summary })
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
