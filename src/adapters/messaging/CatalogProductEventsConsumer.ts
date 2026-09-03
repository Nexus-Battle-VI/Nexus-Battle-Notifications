import type { MessageQueuePort, QueueMessage } from '../../application/ports/MessageQueuePort.js'
import type { HandleCatalogProductCreated } from '../../application/use-cases/HandleCatalogProductCreated.js'
import { CatalogEventProcessOutcome } from '../../application/use-cases/HandleCatalogProductCreated.js'
import type { Logger } from '../../infrastructure/observability/logger.js'
import {
  InvalidEventEnvelopeError,
  parseCatalogProductCreatedEvent,
} from './CatalogProductCreatedParser.js'

export interface CatalogProductEventsConsumerOptions {
  readonly queue: MessageQueuePort
  readonly useCase: HandleCatalogProductCreated
  readonly logger: Logger
  readonly batchSize: number
}

export interface CatalogBatchSummary {
  readonly received: number
  readonly processed: number
  readonly duplicated: number
  readonly requeued: number
  readonly deadLettered: number
}

export class CatalogProductEventsConsumer {
  private readonly options: CatalogProductEventsConsumerOptions

  constructor(options: CatalogProductEventsConsumerOptions) {
    this.options = options
  }

  async processBatch(): Promise<CatalogBatchSummary> {
    const messages = await this.options.queue.receive(this.options.batchSize)

    let processed = 0
    let duplicated = 0
    let requeued = 0
    let deadLettered = 0

    for (const message of messages) {
      const outcome = await this.processMessage(message)

      switch (outcome) {
        case 'processed':
          processed += 1
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

    return { received: messages.length, processed, duplicated, requeued, deadLettered }
  }

  private async processMessage(
    message: QueueMessage,
  ): Promise<'processed' | 'duplicated' | 'requeued' | 'dead-lettered'> {
    let event

    try {
      event = parseCatalogProductCreatedEvent(message.body)
    } catch (error: unknown) {
      const reason =
        error instanceof InvalidEventEnvelopeError
          ? error.message
          : 'Error inesperado al parsear el sobre del evento.'

      this.options.logger.warn('catalog_event_envelope_invalid_dead_lettered', {
        messageId: message.id,
        reason,
        attempt: message.receivedCount,
      })

      await this.options.queue.deadLetter(message.receiptHandle, reason)
      return 'dead-lettered'
    }

    // El número de intento de entrega proviene del contador de entregas de la cola
    const result = await this.options.useCase.execute({
      event,
      deliveryAttempt: message.receivedCount,
    })

    switch (result.outcome) {
      case CatalogEventProcessOutcome.Sent:
        await this.options.queue.acknowledge(message.receiptHandle)
        this.options.logger.info('catalog_product_created_processed', {
          messageId: message.id,
          eventId: result.eventId,
          attempt: result.attempt,
        })
        return 'processed'

      case CatalogEventProcessOutcome.Duplicated:
        await this.options.queue.acknowledge(message.receiptHandle)
        this.options.logger.info('catalog_product_created_duplicated', {
          messageId: message.id,
          eventId: result.eventId,
        })
        return 'duplicated'

      case CatalogEventProcessOutcome.Retry:
        await this.options.queue.requeue(message.receiptHandle, result.retryDelayMs ?? 0)
        this.options.logger.warn('catalog_product_created_requeued', {
          messageId: message.id,
          eventId: result.eventId,
          attempt: result.attempt,
          retryDelayMs: result.retryDelayMs,
          reason: result.reason,
        })
        return 'requeued'

      case CatalogEventProcessOutcome.DeadLetter:
        await this.options.queue.deadLetter(
          message.receiptHandle,
          result.reason ?? 'Agotados los reintentos o fallo no reintentable.',
        )
        this.options.logger.error('catalog_product_created_dead_lettered', {
          messageId: message.id,
          eventId: result.eventId,
          attempt: result.attempt,
          reason: result.reason,
        })
        return 'dead-lettered'
    }
  }
}
