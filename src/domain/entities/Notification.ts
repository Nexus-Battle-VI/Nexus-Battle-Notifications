import { DomainError } from '../errors/DomainError.js'
import type { EmailAddress } from '../value-objects/EmailAddress.js'
import type { NotificationId } from '../value-objects/NotificationId.js'
import type { TemplateId } from '../value-objects/TemplateId.js'
import { NotificationStatus } from './NotificationStatus.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import { notificationSent } from '../events/NotificationSent.js'
import { notificationFailed } from '../events/NotificationFailed.js'
import type { RetryPolicy } from '../policies/RetryPolicy.js'

export type TemplateVariables = Readonly<Record<string, string | number | boolean>>

export interface NotificationSnapshot {
  readonly id: string
  readonly recipient: string
  readonly templateId: string
  readonly status: NotificationStatus
  readonly attempts: number
  readonly lastError: string | null
}

/**
 * Raiz de agregado del contexto Notifications.
 *
 * Concentra la maquina de estados de una notificacion transaccional y decide,
 * junto con la politica de reintentos, si un fallo se reintenta o se descarta.
 * No conoce proveedores de correo, colas ni almacenamiento.
 */
export class Notification {
  private status: NotificationStatus = NotificationStatus.Pending
  private attempts = 0
  private lastError: string | null = null
  private readonly events: DomainEvent[] = []

  readonly id: NotificationId
  readonly recipient: EmailAddress
  readonly templateId: TemplateId
  readonly variables: TemplateVariables

  private constructor(
    id: NotificationId,
    recipient: EmailAddress,
    templateId: TemplateId,
    variables: TemplateVariables,
  ) {
    this.id = id
    this.recipient = recipient
    this.templateId = templateId
    this.variables = variables
  }

  /**
   * `previousAttempts` reconstruye los intentos ya consumidos en entregas
   * anteriores del mismo mensaje. Sin el, una cola con reentrega reconstruiria
   * el agregado desde cero y la politica de reintentos nunca se agotaria.
   */
  static create(params: {
    id: NotificationId
    recipient: EmailAddress
    templateId: TemplateId
    variables?: TemplateVariables
    previousAttempts?: number
  }): Notification {
    const notification = new Notification(
      params.id,
      params.recipient,
      params.templateId,
      params.variables ?? {},
    )

    const previous = params.previousAttempts ?? 0

    if (!Number.isInteger(previous) || previous < 0) {
      throw new DomainError('previousAttempts debe ser un entero mayor o igual a 0.')
    }

    notification.attempts = previous

    return notification
  }

  get currentStatus(): NotificationStatus {
    return this.status
  }

  get attemptCount(): number {
    return this.attempts
  }

  get failureReason(): string | null {
    return this.lastError
  }

  get isTerminal(): boolean {
    return this.status === NotificationStatus.Sent || this.status === NotificationStatus.Discarded
  }

  /** Registra un nuevo intento de entrega. Devuelve el numero de intento. */
  beginAttempt(): number {
    if (this.isTerminal) {
      throw new DomainError(
        `La notificacion ${this.id.value} esta en estado ${this.status} y no admite nuevos intentos.`,
      )
    }

    this.attempts += 1
    this.status = NotificationStatus.Pending

    return this.attempts
  }

  markSent(occurredAt: Date): void {
    if (this.attempts === 0) {
      throw new DomainError('No se puede marcar como enviada una notificacion sin intentos.')
    }

    if (this.isTerminal) {
      throw new DomainError(`La notificacion ${this.id.value} ya alcanzo un estado final.`)
    }

    this.status = NotificationStatus.Sent
    this.lastError = null
    this.events.push(
      notificationSent({
        aggregateId: this.id.value,
        recipient: this.recipient.value,
        templateId: this.templateId.value,
        attempt: this.attempts,
        occurredAt,
      }),
    )
  }

  /**
   * Registra un fallo de entrega y aplica la politica de reintentos.
   * Devuelve `true` cuando el mensaje debe reintentarse.
   */
  markFailed(params: {
    reason: string
    retryable: boolean
    policy: RetryPolicy
    occurredAt: Date
  }): boolean {
    if (this.attempts === 0) {
      throw new DomainError('No se puede registrar un fallo en una notificacion sin intentos.')
    }

    if (this.isTerminal) {
      throw new DomainError(`La notificacion ${this.id.value} ya alcanzo un estado final.`)
    }

    this.lastError = params.reason

    const willRetry = params.policy.shouldRetry(this.attempts, params.retryable)
    this.status = willRetry ? NotificationStatus.Failed : NotificationStatus.Discarded

    this.events.push(
      notificationFailed({
        aggregateId: this.id.value,
        recipient: this.recipient.value,
        templateId: this.templateId.value,
        attempt: this.attempts,
        reason: params.reason,
        retryable: willRetry,
        occurredAt: params.occurredAt,
      }),
    )

    return willRetry
  }

  /** Extrae y limpia los eventos acumulados. */
  pullEvents(): readonly DomainEvent[] {
    const pulled = [...this.events]
    this.events.length = 0

    return pulled
  }

  toSnapshot(): NotificationSnapshot {
    return {
      id: this.id.value,
      recipient: this.recipient.value,
      templateId: this.templateId.value,
      status: this.status,
      attempts: this.attempts,
      lastError: this.lastError,
    }
  }
}
