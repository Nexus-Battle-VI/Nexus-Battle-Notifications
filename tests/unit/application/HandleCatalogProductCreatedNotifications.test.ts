import { describe, expect, it } from '@jest/globals'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryTemplateRenderer } from '../../../src/adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../../src/adapters/templates/default-templates.js'
import { FakeEmailSender } from '../../../src/adapters/email/FakeEmailSender.js'
import { EmailDeliveryError } from '../../../src/application/ports/EmailSenderPort.js'
import { LoggingEventPublisher } from '../../../src/adapters/events/LoggingEventPublisher.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { createLogger } from '../../../src/infrastructure/observability/logger.js'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
import { RetryPolicy } from '../../../src/domain/policies/RetryPolicy.js'
import { HandleCatalogProductCreated } from '../../../src/application/use-cases/HandleCatalogProductCreated.js'
import { HandleCatalogProductCreatedInApp } from '../../../src/application/use-cases/HandleCatalogProductCreatedInApp.js'
import { HandleCatalogProductCreatedNotifications } from '../../../src/application/use-cases/HandleCatalogProductCreatedNotifications.js'
import type { CatalogProductCreatedEvent } from '../../../src/application/dto/CatalogProductCreatedEvent.js'

const event = (): CatalogProductCreatedEvent => ({
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

/**
 * Verifica la composicion de HU-38 (in-app) sobre el correo heredado de
 * HU-33.10 (sin tocar), como describe HandleCatalogProductCreatedNotifications.ts.
 */
describe('HandleCatalogProductCreatedNotifications', () => {
  it('ejecuta el correo transaccional heredado Y crea la notificacion in-app para el mismo mensaje', async () => {
    const emailSender = new FakeEmailSender()
    const notifications = new InMemoryCatalogNotificationRepository()
    const emailUseCase = new HandleCatalogProductCreated({
      emailSender,
      templateRenderer: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      eventPublisher: new LoggingEventPublisher(
        createLogger({ level: 'error', service: 't', version: '0' }),
      ),
      clock: new SystemClock(),
      retryPolicy: RetryPolicy.create({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }),
      idempotencyTtlMs: 60_000,
    })
    const inAppUseCase = new HandleCatalogProductCreatedInApp({
      notifications,
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      clock: new SystemClock(),
      idempotencyTtlMs: 60_000,
    })

    const composite = new HandleCatalogProductCreatedNotifications({ emailUseCase, inAppUseCase })
    const result = await composite.execute({ event: event(), deliveryAttempt: 1 })

    expect(result.outcome).toBe('sent')
    expect(emailSender.sent).toHaveLength(1)
    expect(await notifications.findAllGlobal()).toHaveLength(1)
  })

  it('un correo que agota su carga NO impide que la notificacion in-app se registre', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const emailUseCase = new HandleCatalogProductCreated({
      emailSender: {
        send: (): Promise<never> => Promise.reject(new Error('smtp caido')),
      },
      templateRenderer: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      eventPublisher: new LoggingEventPublisher(
        createLogger({ level: 'error', service: 't', version: '0' }),
      ),
      clock: new SystemClock(),
      // maxAttempts=1: el primer fallo ya agota la carga -> dead-letter, no retry.
      retryPolicy: RetryPolicy.create({ maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000 }),
      idempotencyTtlMs: 60_000,
    })
    const inAppUseCase = new HandleCatalogProductCreatedInApp({
      notifications,
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      clock: new SystemClock(),
      idempotencyTtlMs: 60_000,
    })

    const composite = new HandleCatalogProductCreatedNotifications({ emailUseCase, inAppUseCase })
    const result = await composite.execute({ event: event(), deliveryAttempt: 1 })

    expect(result.outcome).toBe('dead-letter')
    expect(await notifications.findAllGlobal()).toHaveLength(1)
  })

  it('un correo pendiente de reintento pospone tambien la confirmacion del mensaje: la parte in-app se ejecuta en el reintento, no antes', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    let attempts = 0
    const emailUseCase = new HandleCatalogProductCreated({
      emailSender: {
        send: (): Promise<{ providerMessageId: string }> => {
          attempts += 1
          return attempts === 1
            ? Promise.reject(new EmailDeliveryError('timeout', true))
            : Promise.resolve({ providerMessageId: 'fake-1' })
        },
      },
      templateRenderer: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      eventPublisher: new LoggingEventPublisher(
        createLogger({ level: 'error', service: 't', version: '0' }),
      ),
      clock: new SystemClock(),
      retryPolicy: RetryPolicy.create({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }),
      idempotencyTtlMs: 60_000,
    })
    const inAppUseCase = new HandleCatalogProductCreatedInApp({
      notifications,
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      clock: new SystemClock(),
      idempotencyTtlMs: 60_000,
    })
    const composite = new HandleCatalogProductCreatedNotifications({ emailUseCase, inAppUseCase })

    const first = await composite.execute({ event: event(), deliveryAttempt: 1 })
    expect(first.outcome).toBe('retry')
    expect(await notifications.findAllGlobal()).toHaveLength(0)

    const second = await composite.execute({ event: event(), deliveryAttempt: 2 })
    expect(second.outcome).toBe('sent')
    expect(await notifications.findAllGlobal()).toHaveLength(1)
  })
})
