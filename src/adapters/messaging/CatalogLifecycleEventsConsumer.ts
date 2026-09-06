import type { MessageQueuePort, QueueMessage } from '../../application/ports/MessageQueuePort.js'
import type { HandleCatalogLifecycleEvent } from '../../application/use-cases/HandleCatalogLifecycleEvent.js'
import { LifecycleEventOutcome } from '../../application/use-cases/HandleCatalogLifecycleEvent.js'
import type { Logger } from '../../infrastructure/observability/logger.js'
import {
  InvalidLifecycleEventEnvelopeError,
  parseCatalogLifecycleEvent,
} from './CatalogLifecycleEventParser.js'

export interface CatalogLifecycleEventsConsumerOptions {
  readonly queue: MessageQueuePort
  readonly useCase: HandleCatalogLifecycleEvent
  readonly logger: Logger
  readonly batchSize: number
}

export interface LifecycleBatchSummary {
  readonly received: number
  readonly processed: number
  readonly duplicated: number
  readonly recipientsUnresolved: number
  readonly deadLettered: number
}

/**
 * No hay política de reintento aquí a diferencia de `CatalogProductEventsConsumer`:
 * un evento de ciclo de vida válido nunca falla de forma transitoria en este
 * caso de uso (no llama proveedores externos), así que solo hay dos rutas:
 * procesado (o `RecipientsUnresolved`, que también se confirma) o
 * `dead-lettered` cuando el sobre en sí es inválido.
 */
export class CatalogLifecycleEventsConsumer {
  private readonly options: CatalogLifecycleEventsConsumerOptions

  constructor(options: CatalogLifecycleEventsConsumerOptions) {
    this.options = options
  }

  async processBatch(): Promise<LifecycleBatchSummary> {
    const messages = await this.options.queue.receive(this.options.batchSize)

    let processed = 0
    let duplicated = 0
    let recipientsUnresolved = 0
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
        case 'recipients-unresolved':
          recipientsUnresolved += 1
          break
        case 'dead-lettered':
          deadLettered += 1
          break
      }
    }

    return { received: messages.length, processed, duplicated, recipientsUnresolved, deadLettered }
  }

  private async processMessage(
    message: QueueMessage,
  ): Promise<'processed' | 'duplicated' | 'recipients-unresolved' | 'dead-lettered'> {
    let event

    try {
      event = parseCatalogLifecycleEvent(message.body)
    } catch (error: unknown) {
      const reason =
        error instanceof InvalidLifecycleEventEnvelopeError
          ? error.message
          : 'Error inesperado al parsear el sobre del evento.'

      this.options.logger.warn('catalog_lifecycle_event_envelope_invalid_dead_lettered', {
        messageId: message.id,
        reason,
        attempt: message.receivedCount,
      })

      await this.options.queue.deadLetter(message.receiptHandle, reason)
      return 'dead-lettered'
    }

    const result = await this.options.useCase.execute(event)
    await this.options.queue.acknowledge(message.receiptHandle)

    switch (result.outcome) {
      case LifecycleEventOutcome.Processed:
        this.options.logger.info('catalog_lifecycle_event_processed', {
          messageId: message.id,
          eventId: result.eventId,
          notificationsCreated: result.notificationsCreated,
        })
        return 'processed'

      case LifecycleEventOutcome.Duplicated:
        this.options.logger.info('catalog_lifecycle_event_duplicated', {
          messageId: message.id,
          eventId: result.eventId,
        })
        return 'duplicated'

      case LifecycleEventOutcome.RecipientsUnresolved:
        this.options.logger.warn('catalog_lifecycle_event_recipients_unresolved', {
          messageId: message.id,
          eventId: result.eventId,
          reason: result.reason,
        })
        return 'recipients-unresolved'
    }
  }
}
