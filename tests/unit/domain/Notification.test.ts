import { Notification } from '../../../src/domain/entities/Notification.js'
import { NotificationStatus } from '../../../src/domain/entities/NotificationStatus.js'
import { EmailAddress } from '../../../src/domain/value-objects/EmailAddress.js'
import { NotificationId } from '../../../src/domain/value-objects/NotificationId.js'
import { TemplateId } from '../../../src/domain/value-objects/TemplateId.js'
import { RetryPolicy } from '../../../src/domain/policies/RetryPolicy.js'
import { DomainError } from '../../../src/domain/errors/DomainError.js'

const AT = new Date('2026-08-21T10:00:00.000Z')

const build = (): Notification =>
  Notification.create({
    id: NotificationId.create('n-1'),
    recipient: EmailAddress.create('jugador@nexus.test'),
    templateId: TemplateId.create('account-welcome'),
    variables: { displayName: 'Ana' },
  })

const policy = RetryPolicy.create({ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_000 })

describe('Notification', () => {
  it('nace pendiente y sin intentos', () => {
    const notification = build()
    expect(notification.currentStatus).toBe(NotificationStatus.Pending)
    expect(notification.attemptCount).toBe(0)
    expect(notification.failureReason).toBeNull()
    expect(notification.isTerminal).toBe(false)
  })

  it('usa variables vacias cuando no se aportan', () => {
    const notification = Notification.create({
      id: NotificationId.create('n-2'),
      recipient: EmailAddress.create('a@nexus.test'),
      templateId: TemplateId.create('account-welcome'),
    })
    expect(notification.variables).toEqual({})
  })

  it('cuenta los intentos', () => {
    const notification = build()
    expect(notification.beginAttempt()).toBe(1)
    notification.markFailed({ reason: 'timeout', retryable: true, policy, occurredAt: AT })
    expect(notification.beginAttempt()).toBe(2)
  })

  it('emite NotificationSent al marcarse como enviada', () => {
    const notification = build()
    notification.beginAttempt()
    notification.markSent(AT)

    const events = notification.pullEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      name: 'notifications.notification.sent',
      aggregateId: 'n-1',
      attempt: 1,
      occurredAt: AT,
    })
    expect(notification.isTerminal).toBe(true)
    expect(notification.pullEvents()).toHaveLength(0)
  })

  it('marca para reintento mientras la politica lo permita', () => {
    const notification = build()
    notification.beginAttempt()

    expect(
      notification.markFailed({
        reason: 'proveedor caido',
        retryable: true,
        policy,
        occurredAt: AT,
      }),
    ).toBe(true)
    expect(notification.currentStatus).toBe(NotificationStatus.Failed)
    expect(notification.failureReason).toBe('proveedor caido')
    expect(notification.isTerminal).toBe(false)
  })

  it('descarta cuando se agotan los intentos', () => {
    const notification = build()
    notification.beginAttempt()
    notification.markFailed({ reason: 'x', retryable: true, policy, occurredAt: AT })
    notification.beginAttempt()

    expect(notification.markFailed({ reason: 'x', retryable: true, policy, occurredAt: AT })).toBe(
      false,
    )
    expect(notification.currentStatus).toBe(NotificationStatus.Discarded)
    expect(notification.isTerminal).toBe(true)
  })

  it('descarta de inmediato un fallo permanente', () => {
    const notification = build()
    notification.beginAttempt()

    expect(
      notification.markFailed({ reason: 'plantilla', retryable: false, policy, occurredAt: AT }),
    ).toBe(false)
    expect(notification.currentStatus).toBe(NotificationStatus.Discarded)

    const events = notification.pullEvents()
    expect(events[0]).toMatchObject({ name: 'notifications.notification.failed', retryable: false })
  })

  it('reconstruye los intentos consumidos en entregas anteriores', () => {
    const notification = Notification.create({
      id: NotificationId.create('n-1'),
      recipient: EmailAddress.create('a@nexus.test'),
      templateId: TemplateId.create('account-welcome'),
      previousAttempts: 2,
    })

    expect(notification.attemptCount).toBe(2)
    expect(notification.beginAttempt()).toBe(3)
  })

  it('rechaza un numero de intentos previos invalido', () => {
    const base = {
      id: NotificationId.create('n-1'),
      recipient: EmailAddress.create('a@nexus.test'),
      templateId: TemplateId.create('account-welcome'),
    }

    expect(() => Notification.create({ ...base, previousAttempts: -1 })).toThrow(DomainError)
    expect(() => Notification.create({ ...base, previousAttempts: 1.5 })).toThrow(DomainError)
  })

  it('produce una instantanea consistente', () => {
    const notification = build()
    notification.beginAttempt()
    notification.markSent(AT)

    expect(notification.toSnapshot()).toEqual({
      id: 'n-1',
      recipient: 'jugador@nexus.test',
      templateId: 'account-welcome',
      status: NotificationStatus.Sent,
      attempts: 1,
      lastError: null,
    })
  })

  it('impide transiciones invalidas', () => {
    const sinIntentos = build()
    expect(() => {
      sinIntentos.markSent(AT)
    }).toThrow(DomainError)
    expect(() =>
      sinIntentos.markFailed({ reason: 'x', retryable: true, policy, occurredAt: AT }),
    ).toThrow(DomainError)

    const enviada = build()
    enviada.beginAttempt()
    enviada.markSent(AT)
    expect(() => {
      enviada.beginAttempt()
    }).toThrow(DomainError)
    expect(() => {
      enviada.markSent(AT)
    }).toThrow(DomainError)
    expect(() =>
      enviada.markFailed({ reason: 'x', retryable: true, policy, occurredAt: AT }),
    ).toThrow(DomainError)
  })
})
