import type { MessageQueuePort, QueueMessage } from '../../application/ports/MessageQueuePort.js'
import type { SendTransactionalEmail } from '../../application/use-cases/SendTransactionalEmail.js'
import { SendTransactionalEmailOutcome } from '../../application/dto/SendTransactionalEmailCommand.js'
import type { Logger } from '../../infrastructure/observability/logger.js'
import { InvalidMessageError, parseNotificationMessage } from './NotificationMessageParser.js'

export interface NotificationConsumerOptions {
  readonly queue: MessageQueuePort
  readonly useCase: SendTransactionalEmail
  readonly logger: Logger
  readonly batchSize: number
}

export interface BatchSummary {
  readonly received: number
  readonly sent: number
  readonly duplicated: number
  readonly requeued: number
  readonly deadLettered: number
}

/**
 * Adaptador de entrada: consume un lote de la cola y traduce el resultado del
 * caso de uso a la semantica de la cola.
 *
 * Un mensaje malformado va directo a la cola de mensajes fallidos: reintentarlo
 * produciria exactamente el mismo error y bloquearia el consumo.
 */
export class NotificationConsumer {
  private readonly options: NotificationConsumerOptions

  constructor(options: NotificationConsumerOptions) {
    this.options = options
  }

  async processBatch(): Promise<BatchSummary> {
    const messages = await this.options.queue.receive(this.options.batchSize)

    let sent = 0
    let duplicated = 0
    let requeued = 0
    let deadLettered = 0

    for (const message of messages) {
      const outcome = await this.processMessage(message)

      switch (outcome) {
        case 'sent':
          sent += 1
          break
        case 'duplicated':
          duplicated += 1
          break
        case 'requeued':
          requeued += 1
          break
        case 'dead-lettered':
          deadLettered += 1
          break
      }
    }

    return { received: messages.length, sent, duplicated, requeued, deadLettered }
  }

  private async processMessage(
    message: QueueMessage,
  ): Promise<'sent' | 'duplicated' | 'requeued' | 'dead-lettered'> {
    try {
      const command = parseNotificationMessage(message.body)
      const result = await this.options.useCase.execute({
        ...command,
        deliveryAttempt: message.receivedCount,
      })

      switch (result.outcome) {
        case SendTransactionalEmailOutcome.Sent:
          await this.options.queue.acknowledge(message.receiptHandle)
          this.options.logger.info('notification_sent', {
            messageId: message.id,
            notificationId: result.notificationId,
            attempt: result.attempt,
          })
          return 'sent'

        case SendTransactionalEmailOutcome.Duplicated:
          await this.options.queue.acknowledge(message.receiptHandle)
          this.options.logger.info('notification_duplicated', {
            messageId: message.id,
            notificationId: result.notificationId,
          })
          return 'duplicated'

        case SendTransactionalEmailOutcome.Retry:
          await this.options.queue.requeue(message.receiptHandle, result.retryDelayMs ?? 0)
          this.options.logger.warn('notification_requeued', {
            messageId: message.id,
            notificationId: result.notificationId,
            attempt: result.attempt,
            retryDelayMs: result.retryDelayMs,
            reason: result.reason,
          })
          return 'requeued'

        case SendTransactionalEmailOutcome.Discarded:
          await this.options.queue.deadLetter(
            message.receiptHandle,
            result.reason ?? 'Entrega descartada.',
          )
          this.options.logger.error('notification_dead_lettered', {
            messageId: message.id,
            notificationId: result.notificationId,
            attempt: result.attempt,
            reason: result.reason,
          })
          return 'dead-lettered'
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'Fallo desconocido del consumidor.'
      const malformed = error instanceof InvalidMessageError

      await this.options.queue.deadLetter(message.receiptHandle, reason)
      this.options.logger.error('notification_message_rejected', {
        messageId: message.id,
        malformed,
        reason,
      })

      return 'dead-lettered'
    }
  }
}
