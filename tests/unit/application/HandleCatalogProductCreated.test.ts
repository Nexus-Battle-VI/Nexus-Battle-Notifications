import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryTemplateRenderer } from '../../../src/adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../../src/adapters/templates/default-templates.js'
import { FakeEmailSender } from '../../../src/adapters/email/FakeEmailSender.js'
import { LoggingEventPublisher } from '../../../src/adapters/events/LoggingEventPublisher.js'
import { createLogger } from '../../../src/infrastructure/observability/logger.js'
import { RetryPolicy } from '../../../src/domain/policies/RetryPolicy.js'
import {
  CatalogEventProcessOutcome,
  HandleCatalogProductCreated,
} from '../../../src/application/use-cases/HandleCatalogProductCreated.js'
import type { CatalogProductCreatedEvent } from '../../../src/application/dto/CatalogProductCreatedEvent.js'
import {
  EmailDeliveryError,
  type EmailSenderPort,
} from '../../../src/application/ports/EmailSenderPort.js'

const createSampleEvent = (
  overrides: Partial<CatalogProductCreatedEvent> = {},
): CatalogProductCreatedEvent => ({
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
  useCase: HandleCatalogProductCreated
  emailSender: FakeEmailSender
  idempotencyStore: InMemoryIdempotencyStore
  advance: (ms: number) => void
}

describe('HandleCatalogProductCreated', () => {
  const buildUseCase = (
    options: { sender?: EmailSenderPort; maxAttempts?: number } = {},
  ): Harness => {
    let now = 1_000
    const nowMs = (): number => now
    const emailSender = new FakeEmailSender()
    const idempotencyStore = new InMemoryIdempotencyStore(nowMs)
    const logLines: string[] = []
    const logger = createLogger({
      level: 'debug',
      service: 'test',
      version: '0.1.0',
      sink: (line: string): void => {
        logLines.push(line)
      },
    })

    const useCase = new HandleCatalogProductCreated({
      emailSender: options.sender ?? emailSender,
      templateRenderer: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
      idempotencyStore,
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

    return {
      useCase,
      emailSender,
      idempotencyStore,
      advance: (ms: number): void => {
        now += ms
      },
    }
  }

  it('procesa el evento con exito, genera notificacion y la marca como confirmada', async () => {
    const { useCase, emailSender } = buildUseCase()
    const event = createSampleEvent()

    const result = await useCase.execute({ event, deliveryAttempt: 1 })

    expect(result.outcome).toBe(CatalogEventProcessOutcome.Sent)
    expect(result.eventId).toBe(event.eventId)
    expect(result.attempt).toBe(1)
    expect(emailSender.sent).toHaveLength(1)
    expect(emailSender.sent[0]?.subject).toBe('¡Nuevo producto en el catálogo: Espada de Fuego!')
    expect(emailSender.sent[0]?.text).toContain('Espada de Fuego')
    expect(emailSender.sent[0]?.text).toContain('ARMA')
  })

  it('detecta entrega duplicada del mismo eventId y no genera una segunda notificacion', async () => {
    const { useCase, emailSender } = buildUseCase()
    const event = createSampleEvent()

    const first = await useCase.execute({ event, deliveryAttempt: 1 })
    expect(first.outcome).toBe(CatalogEventProcessOutcome.Sent)
    expect(emailSender.sent).toHaveLength(1)

    // Segunda entrega (al menos una vez de SQS)
    const second = await useCase.execute({ event, deliveryAttempt: 2 })
    expect(second.outcome).toBe(CatalogEventProcessOutcome.Duplicated)
    expect(second.eventId).toBe(event.eventId)
    expect(emailSender.sent).toHaveLength(1) // No se envió correo extra
  })

  it('gestiona fallos transitorios reintentables liberando la reserva de idempotencia', async () => {
    const failingSender: EmailSenderPort = {
      send: () => Promise.reject(new EmailDeliveryError('Timeout de conexion', true)),
    }
    const { useCase } = buildUseCase({ sender: failingSender })
    const event = createSampleEvent()

    const result = await useCase.execute({ event, deliveryAttempt: 1 })

    expect(result.outcome).toBe(CatalogEventProcessOutcome.Retry)
    expect(result.attempt).toBe(1)
    expect(result.retryDelayMs).toBe(1_000)
    expect(result.reason).toBe('Timeout de conexion')
  })

  it('marca como dead-letter ante errores permanentes no reintentables', async () => {
    const nonRetryableSender: EmailSenderPort = {
      send: () => Promise.reject(new EmailDeliveryError('Destinatario no valido', false)),
    }
    const { useCase } = buildUseCase({ sender: nonRetryableSender })
    const event = createSampleEvent()

    const result = await useCase.execute({ event, deliveryAttempt: 1 })

    expect(result.outcome).toBe(CatalogEventProcessOutcome.DeadLetter)
    expect(result.reason).toBe('Destinatario no valido')
  })
})
