import type { DomainEvent } from './DomainEvent.js'

export interface NotificationFailed extends DomainEvent {
  readonly name: 'notifications.notification.failed'
  readonly recipient: string
  readonly templateId: string
  readonly attempt: number
  readonly reason: string
  readonly retryable: boolean
}

export const notificationFailed = (params: {
  aggregateId: string
  recipient: string
  templateId: string
  attempt: number
  reason: string
  retryable: boolean
  occurredAt: Date
}): NotificationFailed => ({
  name: 'notifications.notification.failed',
  aggregateId: params.aggregateId,
  recipient: params.recipient,
  templateId: params.templateId,
  attempt: params.attempt,
  reason: params.reason,
  retryable: params.retryable,
  occurredAt: params.occurredAt,
})
