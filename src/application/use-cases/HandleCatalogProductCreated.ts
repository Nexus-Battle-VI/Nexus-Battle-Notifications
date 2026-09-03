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
import type { CatalogProductCreatedEvent } from '../dto/CatalogProductCreatedEvent.js'

export const CatalogEventProcessOutcome = {
  Sent: 'sent',
  Duplicated: 'duplicated',
  Retry: 'retry',
  DeadLetter: 'dead-letter',
} as const

export type CatalogEventProcessOutcome =
  (typeof CatalogEventProcessOutcome)[keyof typeof CatalogEventProcessOutcome]

export interface HandleCatalogProductCreatedResult {
  readonly outcome: CatalogEventProcessOutcome
  readonly eventId: string
  readonly notificationId: string | null
  readonly attempt: number
  readonly retryDelayMs: number | null
  readonly reason: string | null
}

export interface HandleCatalogProductCreatedDependencies {
  readonly emailSender: EmailSenderPort
  readonly templateRenderer: TemplateRendererPort
  readonly idempotencyStore: IdempotencyStorePort
  readonly eventPublisher: EventPublisherPort
  readonly clock: ClockPort
  readonly retryPolicy: RetryPolicy
  readonly idempotencyTtlMs: number
  readonly broadcastRecipient?: string
}

export class HandleCatalogProductCreated {
  private readonly deps: HandleCatalogProductCreatedDependencies

  constructor(deps: HandleCatalogProductCreatedDependencies) {
    this.deps = deps
  }

  async execute(params: {
    event: CatalogProductCreatedEvent
    deliveryAttempt: number
  }): Promise<HandleCatalogProductCreatedResult> {
    const { event, deliveryAttempt } = params
    const eventId = event.eventId
    const idempotencyKey = `catalog:product:created:${eventId}`

    // 1. Idempotencia estricta por eventId
    const reserved = await this.deps.idempotencyStore.reserve(
      idempotencyKey,
      this.deps.idempotencyTtlMs,
    )

    if (!reserved) {
      return {
        outcome: CatalogEventProcessOutcome.Duplicated,
        eventId,
        notificationId: eventId,
        attempt: 0,
        retryDelayMs: null,
        reason: `El evento "${eventId}" ya fue procesado previamente.`,
      }
    }

    const recipient = this.deps.broadcastRecipient ?? 'jugadores@nexus-battles.com'
    const notification = Notification.create({
      id: NotificationId.create(eventId),
      recipient: EmailAddress.create(recipient),
      templateId: TemplateId.create('catalog-product-created'),
      variables: {
        productName: event.data.name,
        productType: event.data.type,
        productId: event.data.productId,
        imageUrl: event.data.imageUrl,
      },
      previousAttempts: Math.max(0, deliveryAttempt - 1),
    })

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
      await this.deps.idempotencyStore.confirm(idempotencyKey)
      await this.deps.eventPublisher.publish(notification.pullEvents())

      return {
        outcome: CatalogEventProcessOutcome.Sent,
        eventId,
        notificationId: notification.id.value,
        attempt,
        retryDelayMs: null,
        reason: null,
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'Fallo inesperado al procesar evento.'
      const retryable = error instanceof EmailDeliveryError ? error.retryable : false

      const willRetry = notification.markFailed({
        reason,
        retryable,
        policy: this.deps.retryPolicy,
        occurredAt: this.deps.clock.now(),
      })

      if (willRetry) {
        // Liberar la reserva para que el siguiente intento de la cola no sea bloqueado
        await this.deps.idempotencyStore.release(idempotencyKey)
        await this.deps.eventPublisher.publish(notification.pullEvents())

        return {
          outcome: CatalogEventProcessOutcome.Retry,
          eventId,
          notificationId: notification.id.value,
          attempt,
          retryDelayMs: this.deps.retryPolicy.delayForAttempt(attempt),
          reason,
        }
      }

      await this.deps.idempotencyStore.confirm(idempotencyKey)
      await this.deps.eventPublisher.publish(notification.pullEvents())

      return {
        outcome: CatalogEventProcessOutcome.DeadLetter,
        eventId,
        notificationId: notification.id.value,
        attempt,
        retryDelayMs: null,
        reason,
      }
    }
  }
}
