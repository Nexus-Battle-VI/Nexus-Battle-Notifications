import { jest } from '@jest/globals'
import { SQSClient } from '@aws-sdk/client-sqs'

import { loadConfig } from '../../../src/infrastructure/config/env.js'
import { buildApplication } from '../../../src/infrastructure/bootstrap/composition-root.js'
import { InMemoryMessageQueue } from '../../../src/adapters/messaging/InMemoryMessageQueue.js'
import { SqsMessageQueue } from '../../../src/adapters/messaging/SqsMessageQueue.js'

/**
 * `buildApplication` no debe atar la eleccion de transporte de
 * `catalog.product.created` a la de la cola general (Infrastructure#93,
 * ADR-017). Estas pruebas fijan ese comportamiento: antes de esta corriccion,
 * `catalogQueue` se derivaba de `queue` y terminaba siendo la cola SQS
 * general (si esa era SQS) o compartiendo la MISMA instancia en memoria (si
 * esa era memoria), ninguna de las dos correcta quando los dos drivers
 * difieren.
 */
describe('buildApplication: independencia de queueDriver y catalogQueueDriver', () => {
  const catalogUrl = 'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created'
  const generalUrl = 'https://sqs.us-east-1.amazonaws.com/1/notificaciones'

  it('caso A: ambos en memoria construye dos InMemoryMessageQueue independientes', () => {
    const config = loadConfig({ QUEUE_DRIVER: 'memory', CATALOG_QUEUE_DRIVER: 'memory' })
    const app = buildApplication(config)

    expect(app.queue).toBeInstanceOf(InMemoryMessageQueue)
    expect(app.catalogQueue).toBeInstanceOf(InMemoryMessageQueue)
    expect(app.catalogQueue).not.toBe(app.queue)
  })

  it('caso B (el que necesita Infrastructure#93): general memoria + Catalog SQS construye dos adaptadores distintos', () => {
    const config = loadConfig({
      QUEUE_DRIVER: 'memory',
      CATALOG_QUEUE_DRIVER: 'sqs',
      CATALOG_QUEUE_URL: catalogUrl,
      AWS_REGION: 'us-east-1',
    })
    const app = buildApplication(config)

    expect(app.queue).toBeInstanceOf(InMemoryMessageQueue)
    expect(app.inMemoryQueue).toBe(app.queue)
    expect(app.catalogQueue).toBeInstanceOf(SqsMessageQueue)
    expect(app.catalogQueue).not.toBe(app.queue)
  })

  it('general SQS + Catalog en memoria: Catalog NO hereda la cola SQS general', () => {
    const config = loadConfig({
      QUEUE_DRIVER: 'sqs',
      QUEUE_URL: generalUrl,
      CATALOG_QUEUE_DRIVER: 'memory',
      AWS_REGION: 'us-east-1',
    })
    const app = buildApplication(config)

    expect(app.queue).toBeInstanceOf(SqsMessageQueue)
    expect(app.catalogQueue).toBeInstanceOf(InMemoryMessageQueue)
    expect(app.catalogQueue).not.toBe(app.queue)
  })

  it('ambas por SQS: dos SqsMessageQueue distintos, cada uno con su propia URL', () => {
    const config = loadConfig({
      QUEUE_DRIVER: 'sqs',
      QUEUE_URL: generalUrl,
      CATALOG_QUEUE_DRIVER: 'sqs',
      CATALOG_QUEUE_URL: catalogUrl,
      AWS_REGION: 'us-east-1',
    })
    const app = buildApplication(config)

    expect(app.queue).toBeInstanceOf(SqsMessageQueue)
    expect(app.catalogQueue).toBeInstanceOf(SqsMessageQueue)
    expect(app.catalogQueue).not.toBe(app.queue)
  })

  it('la cola de Catalog no recibe la DLQ general: no mezcla el dominio de mensajes de dos colas', async () => {
    const config = loadConfig({
      QUEUE_DRIVER: 'sqs',
      QUEUE_URL: generalUrl,
      DEAD_LETTER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/notificaciones-dlq',
      CATALOG_QUEUE_DRIVER: 'sqs',
      CATALOG_QUEUE_URL: catalogUrl,
      AWS_REGION: 'us-east-1',
    })
    const app = buildApplication(config)

    // Sin `deadLetterQueueUrl` en la cola de Catalog, `deadLetter()` cae a
    // `requeue(handle, 0)` -visibilidad 0, ver SqsMessageQueue.deadLetter- en
    // vez de enviar un SendMessageCommand a la DLQ general de notificaciones.
    // Se espia el cliente real de AWS SDK -el mismo que crea
    // `SqsMessageQueue.createClient`- para comprobarlo sin acceder a ningun
    // detalle privado del adaptador.
    const sendSpy = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation(() => Promise.resolve({ $metadata: {} }) as never)

    try {
      await app.catalogQueue.deadLetter('receipt-1', 'motivo de prueba')

      const calledCommands = sendSpy.mock.calls.map(([command]) => command.constructor.name)
      expect(calledCommands).toEqual(['ChangeMessageVisibilityCommand'])
      expect(calledCommands).not.toContain('SendMessageCommand')
    } finally {
      sendSpy.mockRestore()
    }
  })
})

describe('buildApplication: catalogEventsConsumer usa exclusivamente catalogQueue', () => {
  it('un mensaje publicado en catalogQueue no aparece en la cola general, y viceversa', async () => {
    const config = loadConfig({ QUEUE_DRIVER: 'memory', CATALOG_QUEUE_DRIVER: 'memory' })
    const app = buildApplication(config)

    const catalogEvent = JSON.stringify({
      eventId: '2b772782-8814-4c1c-b3ae-a1efca31826d',
      eventType: 'catalog.product.created',
      eventVersion: 1,
      aggregateId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
      occurredAt: '2026-09-02T20:30:00.000Z',
      producer: 'catalog',
      correlationId: 'req-6d87cfc4',
      data: {
        productId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
        name: 'Espada de Fuego',
        type: 'ARMA',
        lifecycleStatus: 'ACTIVE',
        imageUrl: 'https://api.example.test/assets/sword.png',
      },
    })

    ;(app.catalogQueue as InMemoryMessageQueue).publish(catalogEvent)

    const generalSummary = await app.consumer.processBatch()
    expect(generalSummary.received).toBe(0)

    const catalogSummary = await app.catalogEventsConsumer.processBatch()
    expect(catalogSummary.received).toBe(1)
    expect(catalogSummary.processed).toBe(1)
  })
})
