import { InMemoryMessageQueue } from '../../src/adapters/messaging/InMemoryMessageQueue.js'
import { NotificationConsumer } from '../../src/adapters/messaging/NotificationConsumer.js'
import { InMemoryIdempotencyStore } from '../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryTemplateRenderer } from '../../src/adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../src/adapters/templates/default-templates.js'
import { FakeEmailSender } from '../../src/adapters/email/FakeEmailSender.js'
import { LoggingEventPublisher } from '../../src/adapters/events/LoggingEventPublisher.js'
import { SendTransactionalEmail } from '../../src/application/use-cases/SendTransactionalEmail.js'
import {
  EmailDeliveryError,
  type EmailSenderPort,
} from '../../src/application/ports/EmailSenderPort.js'
import { RetryPolicy } from '../../src/domain/policies/RetryPolicy.js'
import { createLogger } from '../../src/infrastructure/observability/logger.js'

interface Harness {
  queue: InMemoryMessageQueue
  consumer: NotificationConsumer
  emailSender: FakeEmailSender
  logLines: string[]
  advance: (ms: number) => void
}

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
    service: 'nexus-battle-notifications',
    version: '0.1.0',
    sink: (line) => logLines.push(line),
  })

  const useCase = new SendTransactionalEmail({
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
  })

  const consumer = new NotificationConsumer({ queue, useCase, logger, batchSize: 10 })

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

const message = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    notificationId: 'n-1',
    recipient: 'jugador@nexus.test',
    templateId: 'account-verification-code',
    variables: { displayName: 'Ana', code: '123456', expiresInMinutes: 10 },
    ...overrides,
  })

describe('Flujo completo de notificaciones', () => {
  it('consume la cola, envia el correo y confirma el mensaje', async () => {
    const harness = buildHarness()
    harness.queue.publish(message())

    const summary = await harness.consumer.processBatch()

    expect(summary).toEqual({
      received: 1,
      sent: 1,
      duplicated: 0,
      requeued: 0,
      deadLettered: 0,
    })
    expect(harness.emailSender.sent[0]?.subject).toBe('Tu codigo de verificacion de Nexus Battles')
    expect(harness.emailSender.sent[0]?.text).toContain('123456')
    expect(harness.queue.pendingCount).toBe(0)
    expect(harness.queue.inFlightCount).toBe(0)
  })

  it('entrega la notificacion de cierre de eliminacion de cuenta (HU-43.4) sin variables', async () => {
    const harness = buildHarness()
    harness.queue.publish(
      message({
        notificationId: 'n-cierre-1',
        templateId: 'account-deletion-closed',
        variables: {},
      }),
    )

    const summary = await harness.consumer.processBatch()

    expect(summary).toEqual({
      received: 1,
      sent: 1,
      duplicated: 0,
      requeued: 0,
      deadLettered: 0,
    })
    expect(harness.emailSender.sent[0]?.subject).toBe(
      'Tu solicitud de eliminación de cuenta ha finalizado',
    )
    expect(harness.emailSender.sent[0]?.text).toContain('ha finalizado')
  })

  it('procesa varios mensajes en un solo lote', async () => {
    const harness = buildHarness()
    harness.queue.publish(message({ notificationId: 'n-1' }))
    harness.queue.publish(message({ notificationId: 'n-2' }))
    harness.queue.publish(message({ notificationId: 'n-3' }))

    const summary = await harness.consumer.processBatch()

    expect(summary.received).toBe(3)
    expect(summary.sent).toBe(3)
    expect(harness.emailSender.sent).toHaveLength(3)
  })

  it('no envia dos veces una notificacion reentregada por la cola', async () => {
    const harness = buildHarness()
    harness.queue.publish(message())
    harness.queue.publish(message())

    const summary = await harness.consumer.processBatch()

    expect(summary.sent).toBe(1)
    expect(summary.duplicated).toBe(1)
    expect(harness.emailSender.sent).toHaveLength(1)
  })

  it('reencola con retroceso ante un fallo transitorio y entrega en el reintento', async () => {
    let intentos = 0
    const inestable: EmailSenderPort = {
      send: (email) => {
        intentos += 1

        if (intentos === 1) {
          return Promise.reject(new EmailDeliveryError('proveedor no disponible', true))
        }

        return harness.emailSender.send(email)
      },
    }

    const harness = buildHarness({ sender: inestable })
    harness.queue.publish(message())

    const first = await harness.consumer.processBatch()
    expect(first.requeued).toBe(1)
    expect(harness.emailSender.sent).toHaveLength(0)

    // El mensaje permanece invisible hasta que vence el retroceso exponencial.
    expect((await harness.consumer.processBatch()).received).toBe(0)

    harness.advance(1_000)
    const second = await harness.consumer.processBatch()

    expect(second.sent).toBe(1)
    expect(harness.emailSender.sent).toHaveLength(1)
    expect(harness.queue.deadLettered).toHaveLength(0)
  })

  it('agota los reintentos y termina en la cola de mensajes fallidos', async () => {
    const caido: EmailSenderPort = {
      send: () => Promise.reject(new EmailDeliveryError('proveedor caido', true)),
    }
    const harness = buildHarness({ sender: caido, maxAttempts: 2 })
    harness.queue.publish(message())

    expect((await harness.consumer.processBatch()).requeued).toBe(1)

    harness.advance(1_000)
    const second = await harness.consumer.processBatch()

    expect(second.deadLettered).toBe(1)
    expect(harness.queue.deadLettered).toHaveLength(1)
    expect(harness.queue.deadLettered[0]?.reason).toBe('proveedor caido')
    expect(harness.queue.pendingCount).toBe(0)
  })

  it('envia a la cola de fallidos un mensaje malformado sin reintentarlo', async () => {
    const harness = buildHarness()
    harness.queue.publish('{ esto no es json')

    const summary = await harness.consumer.processBatch()

    expect(summary.deadLettered).toBe(1)
    expect(harness.queue.pendingCount).toBe(0)
    expect(
      harness.logLines.some((line) => {
        const parsed = JSON.parse(line) as { message?: string; malformed?: boolean }

        return parsed.message === 'notification_message_rejected' && parsed.malformed === true
      }),
    ).toBe(true)
  })

  it('envia a la cola de fallidos un destinatario invalido', async () => {
    const harness = buildHarness()
    harness.queue.publish(message({ recipient: 'no-es-correo' }))

    const summary = await harness.consumer.processBatch()

    expect(summary.deadLettered).toBe(1)
    expect(harness.queue.deadLettered[0]?.reason).toMatch(/no tiene un formato valido/)
  })

  it('envia a la cola de fallidos una plantilla inexistente sin reintentar', async () => {
    const harness = buildHarness()
    harness.queue.publish(message({ templateId: 'plantilla-inexistente' }))

    const summary = await harness.consumer.processBatch()

    expect(summary.deadLettered).toBe(1)
    expect(summary.requeued).toBe(0)
  })

  it('devuelve un resumen vacio cuando no hay mensajes', async () => {
    const harness = buildHarness()

    expect(await harness.consumer.processBatch()).toEqual({
      received: 0,
      sent: 0,
      duplicated: 0,
      requeued: 0,
      deadLettered: 0,
    })
  })
})
