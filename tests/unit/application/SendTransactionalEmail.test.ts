import { jest } from '@jest/globals'

import { SendTransactionalEmail } from '../../../src/application/use-cases/SendTransactionalEmail.js'
import { SendTransactionalEmailOutcome } from '../../../src/application/dto/SendTransactionalEmailCommand.js'
import { EmailDeliveryError } from '../../../src/application/ports/EmailSenderPort.js'
import type { EmailSenderPort } from '../../../src/application/ports/EmailSenderPort.js'
import type { EventPublisherPort } from '../../../src/application/ports/EventPublisherPort.js'
import { RetryPolicy } from '../../../src/domain/policies/RetryPolicy.js'
import { FakeEmailSender } from '../../../src/adapters/email/FakeEmailSender.js'
import { InMemoryTemplateRenderer } from '../../../src/adapters/templates/InMemoryTemplateRenderer.js'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import type { DomainEvent } from '../../../src/domain/events/DomainEvent.js'

const FIXED_NOW = new Date('2026-08-21T10:00:00.000Z')

const templates = InMemoryTemplateRenderer.fromRecord({
  'account-welcome': {
    subject: 'Bienvenido {{displayName}}',
    html: '<p>Hola {{displayName}}</p>',
    text: 'Hola {{displayName}}',
  },
})

class RecordingPublisher implements EventPublisherPort {
  readonly published: DomainEvent[] = []

  publish(events: readonly DomainEvent[]): Promise<void> {
    this.published.push(...events)

    return Promise.resolve()
  }
}

const buildUseCase = (
  overrides: { emailSender?: EmailSenderPort; maxAttempts?: number } = {},
): {
  useCase: SendTransactionalEmail
  emailSender: FakeEmailSender
  publisher: RecordingPublisher
  store: InMemoryIdempotencyStore
} => {
  const emailSender = new FakeEmailSender()
  const publisher = new RecordingPublisher()
  const store = new InMemoryIdempotencyStore(() => FIXED_NOW.getTime())

  const useCase = new SendTransactionalEmail({
    emailSender: overrides.emailSender ?? emailSender,
    templateRenderer: templates,
    idempotencyStore: store,
    eventPublisher: publisher,
    clock: { now: (): Date => FIXED_NOW },
    retryPolicy: RetryPolicy.create({
      maxAttempts: overrides.maxAttempts ?? 3,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
    }),
    idempotencyTtlMs: 60_000,
  })

  return { useCase, emailSender, publisher, store }
}

const command = {
  notificationId: 'n-1',
  recipient: 'jugador@nexus.test',
  templateId: 'account-welcome',
  variables: { displayName: 'Ana' },
}

// El caso de uso debe tolerar cualquier rechazo del adaptador, incluido uno que
// no sea Error. Por eso este ayudante acepta `unknown` deliberadamente.
const rejectWith = (error: unknown): EmailSenderPort => ({
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  send: jest.fn(() => Promise.reject(error)),
})

describe('SendTransactionalEmail', () => {
  it('envia el correo y publica el evento de dominio', async () => {
    const { useCase, emailSender, publisher } = buildUseCase()

    const result = await useCase.execute(command)

    expect(result.outcome).toBe(SendTransactionalEmailOutcome.Sent)
    expect(result.attempt).toBe(1)
    expect(result.retryDelayMs).toBeNull()
    expect(emailSender.sent).toEqual([
      {
        to: 'jugador@nexus.test',
        subject: 'Bienvenido Ana',
        html: '<p>Hola Ana</p>',
        text: 'Hola Ana',
      },
    ])
    expect(publisher.published[0]).toMatchObject({ name: 'notifications.notification.sent' })
  })

  it('deduplica una reentrega de la cola', async () => {
    const { useCase, emailSender } = buildUseCase()

    await useCase.execute(command)
    const second = await useCase.execute(command)

    expect(second.outcome).toBe(SendTransactionalEmailOutcome.Duplicated)
    expect(second.attempt).toBe(0)
    expect(emailSender.sent).toHaveLength(1)
  })

  it('usa la clave de idempotencia explicita cuando se aporta', async () => {
    const { useCase, emailSender } = buildUseCase()

    await useCase.execute({ ...command, idempotencyKey: 'k-1' })
    const second = await useCase.execute({
      ...command,
      notificationId: 'n-2',
      idempotencyKey: 'k-1',
    })

    expect(second.outcome).toBe(SendTransactionalEmailOutcome.Duplicated)
    expect(emailSender.sent).toHaveLength(1)
  })

  it('solicita reintento ante un fallo transitorio y libera la reserva', async () => {
    const { useCase, publisher, store } = buildUseCase({
      emailSender: rejectWith(new EmailDeliveryError('proveedor no disponible', true)),
    })

    const result = await useCase.execute(command)

    expect(result.outcome).toBe(SendTransactionalEmailOutcome.Retry)
    expect(result.retryDelayMs).toBe(1_000)
    expect(result.reason).toBe('proveedor no disponible')
    expect(store.size).toBe(0)
    expect(publisher.published[0]).toMatchObject({
      name: 'notifications.notification.failed',
      retryable: true,
    })
  })

  it('descarta un fallo permanente del proveedor y conserva la clave', async () => {
    const { useCase, store } = buildUseCase({
      emailSender: rejectWith(new EmailDeliveryError('destinatario rechazado', false)),
    })

    const result = await useCase.execute(command)

    expect(result.outcome).toBe(SendTransactionalEmailOutcome.Discarded)
    expect(result.retryDelayMs).toBeNull()
    expect(store.size).toBe(1)
  })

  it('descarta sin reintentar cuando la plantilla no existe', async () => {
    const { useCase, emailSender } = buildUseCase()

    const result = await useCase.execute({ ...command, templateId: 'inexistente' })

    expect(result.outcome).toBe(SendTransactionalEmailOutcome.Discarded)
    expect(result.reason).toContain('inexistente')
    expect(emailSender.sent).toHaveLength(0)
  })

  it('descarta un error inesperado del adaptador', async () => {
    const { useCase } = buildUseCase({ emailSender: rejectWith(new Error('fallo no clasificado')) })

    const result = await useCase.execute(command)

    expect(result.outcome).toBe(SendTransactionalEmailOutcome.Discarded)
    expect(result.reason).toBe('fallo no clasificado')
  })

  it('descarta cuando el adaptador rechaza con un valor que no es Error', async () => {
    const { useCase } = buildUseCase({ emailSender: rejectWith('cadena suelta') })

    const result = await useCase.execute(command)

    expect(result.reason).toBe('Fallo desconocido en la entrega.')
  })

  it('propaga la validacion del dominio ante un destinatario invalido', async () => {
    const { useCase } = buildUseCase()

    await expect(useCase.execute({ ...command, recipient: 'no-es-correo' })).rejects.toThrow(
      /no tiene un formato valido/,
    )
  })

  it('cuenta los intentos previos informados por la cola', async () => {
    const { useCase } = buildUseCase({
      emailSender: rejectWith(new EmailDeliveryError('caido', true)),
      maxAttempts: 3,
    })

    const result = await useCase.execute({ ...command, deliveryAttempt: 3 })

    expect(result.attempt).toBe(3)
    expect(result.outcome).toBe(SendTransactionalEmailOutcome.Discarded)
  })

  it('deja de reintentar al alcanzar el maximo de intentos', async () => {
    const { useCase } = buildUseCase({
      emailSender: rejectWith(new EmailDeliveryError('caido', true)),
      maxAttempts: 1,
    })

    const result = await useCase.execute(command)

    expect(result.outcome).toBe(SendTransactionalEmailOutcome.Discarded)
  })
})
