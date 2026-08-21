import { Notification } from '../../domain/entities/Notification.js'
import { EmailAddress } from '../../domain/value-objects/EmailAddress.js'
import { NotificationId } from '../../domain/value-objects/NotificationId.js'
import { TemplateId } from '../../domain/value-objects/TemplateId.js'
import type { RetryPolicy } from '../../domain/policies/RetryPolicy.js'
import type { ClockPort } from '../ports/ClockPort.js'
import type { EmailSenderPort } from '../ports/EmailSenderPort.js'
import { EmailDeliveryError } from '../ports/EmailSenderPort.js'
import type { EventPublisherPort } from '../ports/EventPublisherPort.js'
import type { IdempotencyStorePort } from '../ports/IdempotencyStorePort.js'
import type { TemplateRendererPort } from '../ports/TemplateRendererPort.js'
import { TemplateNotFoundError } from '../ports/TemplateRendererPort.js'
import type { SendTransactionalEmailCommand } from '../dto/SendTransactionalEmailCommand.js'
import {
  SendTransactionalEmailOutcome,
  type SendTransactionalEmailResult,
} from '../dto/SendTransactionalEmailCommand.js'

export interface SendTransactionalEmailDependencies {
  readonly emailSender: EmailSenderPort
  readonly templateRenderer: TemplateRendererPort
  readonly idempotencyStore: IdempotencyStorePort
  readonly eventPublisher: EventPublisherPort
  readonly clock: ClockPort
  readonly retryPolicy: RetryPolicy
  readonly idempotencyTtlMs: number
}

/**
 * Caso de uso central del contexto Notifications.
 *
 * Orquesta idempotencia, renderizado, envio y politica de reintentos. Depende
 * exclusivamente de puertos: no conoce SQS, SMTP, SES ni almacenamiento.
 */
export class SendTransactionalEmail {
  private readonly deps: SendTransactionalEmailDependencies

  constructor(deps: SendTransactionalEmailDependencies) {
    this.deps = deps
  }

  async execute(command: SendTransactionalEmailCommand): Promise<SendTransactionalEmailResult> {
    const notification = Notification.create({
      id: NotificationId.create(command.notificationId),
      recipient: EmailAddress.create(command.recipient),
      templateId: TemplateId.create(command.templateId),
      variables: command.variables,
      previousAttempts: Math.max(0, (command.deliveryAttempt ?? 1) - 1),
    })

    const key = command.idempotencyKey ?? command.notificationId
    const reserved = await this.deps.idempotencyStore.reserve(key, this.deps.idempotencyTtlMs)

    if (!reserved) {
      return {
        outcome: SendTransactionalEmailOutcome.Duplicated,
        notificationId: notification.id.value,
        attempt: 0,
        retryDelayMs: null,
        reason: 'La notificacion ya fue procesada previamente.',
      }
    }

    const attempt = notification.beginAttempt()

    try {
      const rendered = await this.deps.templateRenderer.render(
        notification.templateId.value,
        notification.variables,
      )

      await this.deps.emailSender.send({
        to: notification.recipient.value,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      })

      notification.markSent(this.deps.clock.now())
      await this.deps.idempotencyStore.confirm(key)
      await this.deps.eventPublisher.publish(notification.pullEvents())

      return {
        outcome: SendTransactionalEmailOutcome.Sent,
        notificationId: notification.id.value,
        attempt,
        retryDelayMs: null,
        reason: null,
      }
    } catch (error: unknown) {
      return await this.handleFailure({ notification, attempt, key, error })
    }
  }

  private async handleFailure(params: {
    notification: Notification
    attempt: number
    key: string
    error: unknown
  }): Promise<SendTransactionalEmailResult> {
    const { notification, attempt, key, error } = params

    const retryable = SendTransactionalEmail.isRetryable(error)
    const reason = error instanceof Error ? error.message : 'Fallo desconocido en la entrega.'

    const willRetry = notification.markFailed({
      reason,
      retryable,
      policy: this.deps.retryPolicy,
      occurredAt: this.deps.clock.now(),
    })

    // Solo se libera la reserva cuando habra un reintento. Si el mensaje se
    // descarta, la clave permanece para impedir que un reenvio tardio de la
    // cola vuelva a intentar una notificacion ya abandonada.
    if (willRetry) {
      await this.deps.idempotencyStore.release(key)
    } else {
      await this.deps.idempotencyStore.confirm(key)
    }

    await this.deps.eventPublisher.publish(notification.pullEvents())

    return {
      outcome: willRetry
        ? SendTransactionalEmailOutcome.Retry
        : SendTransactionalEmailOutcome.Discarded,
      notificationId: notification.id.value,
      attempt,
      retryDelayMs: willRetry ? this.deps.retryPolicy.delayForAttempt(attempt) : null,
      reason,
    }
  }

  /**
   * Una plantilla inexistente es un defecto de configuracion, no una
   * indisponibilidad: reintentarla solo consume la cola. Los fallos del
   * proveedor declaran explicitamente si admiten reintento.
   */
  private static isRetryable(error: unknown): boolean {
    if (error instanceof TemplateNotFoundError) {
      return false
    }

    if (error instanceof EmailDeliveryError) {
      return error.retryable
    }

    return false
  }
}
