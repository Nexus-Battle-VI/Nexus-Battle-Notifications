import type { DomainEvent } from './DomainEvent.js'

export interface NotificationSent extends DomainEvent {
  readonly name: 'notifications.notification.sent'
  readonly recipient: string
  readonly templateId: string
  readonly attempt: number
}

export const notificationSent = (params: {
  aggregateId: string
  recipient: string
  templateId: string
  attempt: number
  occurredAt: Date
}): NotificationSent => ({
  name: 'notifications.notification.sent',
  aggregateId: params.aggregateId,
  recipient: params.recipient,
  templateId: params.templateId,
  attempt: params.attempt,
  occurredAt: params.occurredAt,
})
