import { jest } from '@jest/globals'
import { SQSClient } from '@aws-sdk/client-sqs'

import {
  buildCatalogNotificationsApplication,
  type CatalogNotificationsApplication,
} from '../../../src/infrastructure/bootstrap/catalog-notifications-application.js'
import { loadConfig } from '../../../src/infrastructure/config/env.js'
import { buildApplication } from '../../../src/infrastructure/bootstrap/composition-root.js'
import { InMemoryMessageQueue } from '../../../src/adapters/messaging/InMemoryMessageQueue.js'
import { SqsMessageQueue } from '../../../src/adapters/messaging/SqsMessageQueue.js'
import { createLogger } from '../../../src/infrastructure/observability/logger.js'

/** Cierra tambien el servidor HTTP -`close()` de la app solo cierra Mongo-, para no dejar el puerto ocupado entre pruebas. */
const teardown = async (catalogApp: CatalogNotificationsApplication | null): Promise<void> => {
  if (catalogApp === null) {
    return
  }

  await catalogApp.close()
  await new Promise<void>((resolve) => {
    catalogApp.server.close(() => {
      resolve()
    })
  })
}

/**
 * `lifecycleQueue` no debe depender de `queueDriver` (cola general) ni de
 * `catalogQueueDriver` (`catalog.product.created`, Notifications#23). Antes
 * de esta corriccion, `lifecycleQueue` se activaba con
 * `config.queueDriver === 'sqs'` y reenviaba a `config.deadLetterQueueUrl`
 * -la DLQ general-, exactamente el acoplamiento que Notifications#23 ya
 * habia resuelto para `created` pero no para el ciclo de vida (ADR-018,
 * Infrastructure#95).
 */
describe('buildCatalogNotificationsApplication: cola lifecycle independiente (ADR-018)', () => {
  const silentLogger = createLogger({ level: 'error', service: 'test', version: '0.0.0' })

  const BASE = {
    CATALOG_NOTIFICATIONS_HTTP_ENABLED: 'true',
    CATALOG_NOTIFICATIONS_REPOSITORY_DRIVER: 'memory',
    COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
    COGNITO_CLIENT_ID: 'cliente-de-pruebas',
  }

  const lifecycleUrl = 'https://sqs.us-east-1.amazonaws.com/1/catalog-lifecycle-notifications'
  const createdUrl = 'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created-notifications'
  const generalUrl = 'https://sqs.us-east-1.amazonaws.com/1/notificaciones'

  it('caso A (local): general/created/lifecycle en memoria son tres colas independientes', async () => {
    const config = loadConfig({
      ...BASE,
      QUEUE_DRIVER: 'memory',
      CATALOG_QUEUE_DRIVER: 'memory',
      CATALOG_LIFECYCLE_QUEUE_DRIVER: 'memory',
    })

    const app = buildApplication(config)
    const catalogApp = await buildCatalogNotificationsApplication(config, silentLogger)

    expect(catalogApp).not.toBeNull()
    const lifecycleQueue = catalogApp?.lifecycleQueue

    expect(app.queue).toBeInstanceOf(InMemoryMessageQueue)
    expect(app.catalogQueue).toBeInstanceOf(InMemoryMessageQueue)
    expect(lifecycleQueue).toBeInstanceOf(InMemoryMessageQueue)

    expect(lifecycleQueue).not.toBe(app.queue)
    expect(lifecycleQueue).not.toBe(app.catalogQueue)
    expect(app.catalogQueue).not.toBe(app.queue)

    await teardown(catalogApp)
  })

  it('caso B (escenario objetivo de HU-38): general memoria, created SQS, lifecycle SQS -tres transportes, cada uno con su URL-', async () => {
    const config = loadConfig({
      ...BASE,
      QUEUE_DRIVER: 'memory',
      CATALOG_QUEUE_DRIVER: 'sqs',
      CATALOG_QUEUE_URL: createdUrl,
      CATALOG_LIFECYCLE_QUEUE_DRIVER: 'sqs',
      CATALOG_LIFECYCLE_QUEUE_URL: lifecycleUrl,
      AWS_REGION: 'us-east-1',
    })

    const app = buildApplication(config)
    const catalogApp = await buildCatalogNotificationsApplication(config, silentLogger)

    expect(app.queue).toBeInstanceOf(InMemoryMessageQueue)
    expect(app.catalogQueue).toBeInstanceOf(SqsMessageQueue)
    expect(catalogApp?.lifecycleQueue).toBeInstanceOf(SqsMessageQueue)
    expect(catalogApp?.lifecycleQueue).not.toBe(app.catalogQueue)

    await teardown(catalogApp)
  })

  it('caso 8 caracterizado a nivel de aplicacion: lifecycle memory no se activa por SQS aunque general y created sean sqs', async () => {
    const config = loadConfig({
      ...BASE,
      QUEUE_DRIVER: 'sqs',
      QUEUE_URL: generalUrl,
      CATALOG_QUEUE_DRIVER: 'sqs',
      CATALOG_QUEUE_URL: createdUrl,
      CATALOG_LIFECYCLE_QUEUE_DRIVER: 'memory',
      AWS_REGION: 'us-east-1',
    })

    const app = buildApplication(config)
    const catalogApp = await buildCatalogNotificationsApplication(config, silentLogger)

    expect(app.queue).toBeInstanceOf(SqsMessageQueue)
    expect(app.catalogQueue).toBeInstanceOf(SqsMessageQueue)
    expect(catalogApp?.lifecycleQueue).toBeInstanceOf(InMemoryMessageQueue)

    await teardown(catalogApp)
  })

  it('lifecycle NO reenvia a la DLQ general: un mensaje irreprocesable usa la redrive policy de su propia cola', async () => {
    const config = loadConfig({
      ...BASE,
      QUEUE_DRIVER: 'sqs',
      QUEUE_URL: generalUrl,
      DEAD_LETTER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/notificaciones-dlq',
      CATALOG_LIFECYCLE_QUEUE_DRIVER: 'sqs',
      CATALOG_LIFECYCLE_QUEUE_URL: lifecycleUrl,
      AWS_REGION: 'us-east-1',
    })

    const catalogApp = await buildCatalogNotificationsApplication(config, silentLogger)

    // Se espia el cliente real de AWS SDK -el mismo que crea
    // `SqsMessageQueue.createClient`- para comprobar sin acceder a ningun
    // detalle privado del adaptador, igual que la prueba equivalente de
    // Notifications#23 para `catalogQueue`.
    const sendSpy = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation(() => Promise.resolve({ $metadata: {} }) as never)

    try {
      await catalogApp?.lifecycleQueue.deadLetter('receipt-1', 'motivo de prueba')

      const calledCommands = sendSpy.mock.calls.map(([command]) => command.constructor.name)
      expect(calledCommands).toEqual(['ChangeMessageVisibilityCommand'])
      expect(calledCommands).not.toContain('SendMessageCommand')
    } finally {
      sendSpy.mockRestore()
      await teardown(catalogApp)
    }
  })
})
