import { InMemoryMessageQueue } from '../../../src/adapters/messaging/InMemoryMessageQueue.js'
import { CatalogProductEventsConsumer } from '../../../src/adapters/messaging/CatalogProductEventsConsumer.js'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryTemplateRenderer } from '../../../src/adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../../src/adapters/templates/default-templates.js'
import { FakeEmailSender } from '../../../src/adapters/email/FakeEmailSender.js'
import { LoggingEventPublisher } from '../../../src/adapters/events/LoggingEventPublisher.js'
import { HandleCatalogProductCreated } from '../../../src/application/use-cases/HandleCatalogProductCreated.js'
import { RetryPolicy } from '../../../src/domain/policies/RetryPolicy.js'
import { createLogger } from '../../../src/infrastructure/observability/logger.js'
import {
  EmailDeliveryError,
  type EmailSenderPort,
} from '../../../src/application/ports/EmailSenderPort.js'

const validEventPayload = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
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
    ...overrides,
  })

interface Harness {
  queue: InMemoryMessageQueue
  consumer: CatalogProductEventsConsumer
  emailSender: FakeEmailSender
  logLines: string[]
  advance: (ms: number) => void
}

describe('CatalogProductEventsConsumer', () => {
  const buildHarness = (
    options: { sender?: EmailSenderPort; maxAttempts?: number } = {},
  ): Harness => {
    let now = 1_000
    const nowMs = (): number => now
    const queue = new InMemoryMessageQueue(nowMs)
    const emailSender = new FakeEmailSender()
    const logLines: string[] = []
    const logger = createLogger({
      level: 'debug',
      service: 'test',
      version: '0.1.0',
      sink: (line) => logLines.push(line),
    })

    const useCase = new HandleCatalogProductCreated({
      emailSender: options.sender ?? emailSender,
      templateRenderer: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
      idempotencyStore: new InMemoryIdempotencyStore(nowMs),
      eventPublisher: new LoggingEventPublisher(logger),
      clock: { now: (): Date => new Date(now) },
      retryPolicy: RetryPolicy.create({
        maxAttempts: options.maxAttempts ?? 3,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
      }),
      idempotencyTtlMs: 600_000,
      broadcastRecipient: 'jugadores@nexus.test',
    })

    const consumer = new CatalogProductEventsConsumer({
      queue,
      useCase,
      logger,
      batchSize: 10,
    })

    return {
      queue,
      consumer,
      emailSender,
      logLines,
      advance: (ms: number): void => {
        now += ms
      },
    }
  }

  it('consume el lote, procesa el evento y confirma el mensaje en la cola', async () => {
    const harness = buildHarness()
    harness.queue.publish(validEventPayload())

    const summary = await harness.consumer.processBatch()

    expect(summary).toEqual({
      received: 1,
      processed: 1,
      duplicated: 0,
      requeued: 0,
      deadLettered: 0,
    })
    expect(harness.emailSender.sent).toHaveLength(1)
    expect(harness.emailSender.sent[0]?.subject).toBe(
      '¡Nuevo producto en el catálogo: Espada de Fuego!',
    )
    expect(harness.queue.pendingCount).toBe(0)
    expect(harness.queue.inFlightCount).toBe(0)
  })

  it('control negativo: version desconocida (eventVersion: 2) va directo a DLQ y NO se confirma ni descarta en silencio', async () => {
    const harness = buildHarness()
    harness.queue.publish(validEventPayload({ eventVersion: 2 }))

    const summary = await harness.consumer.processBatch()

    expect(summary).toEqual({
      received: 1,
      processed: 0,
      duplicated: 0,
      requeued: 0,
      deadLettered: 1,
    })
    expect(harness.emailSender.sent).toHaveLength(0)
    expect(harness.queue.deadLettered).toHaveLength(1)
    expect(harness.queue.deadLettered[0]?.reason).toContain('Version de evento no soportada: "2"')
    expect(harness.queue.inFlightCount).toBe(0)
  })

  it('control negativo: mensaje malformado va directo a DLQ', async () => {
    const harness = buildHarness()
    harness.queue.publish('{json:invalido')

    const summary = await harness.consumer.processBatch()

    expect(summary.deadLettered).toBe(1)
    expect(harness.queue.deadLettered).toHaveLength(1)
    expect(harness.queue.deadLettered[0]?.reason).toBe('El cuerpo del mensaje no es JSON valido.')
  })

  it('control de idempotencia: el mismo evento entregado dos veces genera exactamente una notificacion', async () => {
    const harness = buildHarness()
    const payload = validEventPayload()
    harness.queue.publish(payload)
    harness.queue.publish(payload)

    const summary = await harness.consumer.processBatch()

    expect(summary.received).toBe(2)
    expect(summary.processed).toBe(1)
    expect(summary.duplicated).toBe(1)
    expect(harness.emailSender.sent).toHaveLength(1)
    expect(harness.queue.pendingCount).toBe(0)
    expect(harness.queue.inFlightCount).toBe(0)
  })

  it('control de intento de entrega: el numero de intento sale de receivedCount de la cola, no del proceso', async () => {
    let callCount = 0
    const flakySender: EmailSenderPort = {
      send: () => {
        callCount += 1
        if (callCount < 2) {
          return Promise.reject(new EmailDeliveryError('Fallo de red transitorio', true))
        }
        return Promise.resolve({ providerMessageId: 'ok-1' })
      },
    }

    const harness = buildHarness({ sender: flakySender })
    harness.queue.publish(validEventPayload())

    // Primer intento: falla y se reencola
    const firstSummary = await harness.consumer.processBatch()
    expect(firstSummary.requeued).toBe(1)
    expect(harness.emailSender.sent).toHaveLength(0)

    // Avanzamos el reloj para que el mensaje vuelva a estar visible en la cola
    harness.advance(2_000)

    // Segundo intento: la cola entrega con receivedCount = 2
    const secondSummary = await harness.consumer.processBatch()
    expect(secondSummary.processed).toBe(1)
    expect(secondSummary.requeued).toBe(0)
    expect(callCount).toBe(2)
  })
})
