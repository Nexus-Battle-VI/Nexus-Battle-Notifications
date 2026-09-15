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
  readonly requeued: number
  readonly deadLettered: number
}

/**
 * Suspensión y reactivación llaman a Player-Inventory para resolver
 * propietarios (`ProductOwnersResolverPort`, ver Notifications#21): un
 * timeout, un error de red o un `5xx` son fallos TRANSITORIOS del mensaje,
 * igual que un proveedor de correo caído en `CatalogProductEventsConsumer`.
 * Por eso este consumidor sigue exactamente el mismo patrón de
 * ack/requeue/dead-letter que aquel -antes de este cambio, todo resultado
 * distinto de un sobre inválido se confirmaba sin más, lo que perdía la
 * notificación en silencio ante cualquier fallo temporal de Player-Inventory-.
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

    // El número de intento de entrega proviene del contador de entregas de la
    // cola, igual que en CatalogProductEventsConsumer.
    const result = await this.options.useCase.execute({
      event,
      deliveryAttempt: message.receivedCount,
    })

    switch (result.outcome) {
      case LifecycleEventOutcome.Processed:
        await this.options.queue.acknowledge(message.receiptHandle)
        this.options.logger.info('catalog_lifecycle_event_processed', {
          messageId: message.id,
          eventId: result.eventId,
          notificationsCreated: result.notificationsCreated,
        })
        return 'processed'

      case LifecycleEventOutcome.Duplicated:
        await this.options.queue.acknowledge(message.receiptHandle)
        this.options.logger.info('catalog_lifecycle_event_duplicated', {
          messageId: message.id,
          eventId: result.eventId,
        })
        return 'duplicated'

      case LifecycleEventOutcome.Retry:
        await this.options.queue.requeue(message.receiptHandle, result.retryDelayMs ?? 0)
        this.options.logger.warn('catalog_lifecycle_event_requeued', {
          messageId: message.id,
          eventId: result.eventId,
          attempt: result.attempt,
          retryDelayMs: result.retryDelayMs,
          reason: result.reason,
        })
        return 'requeued'

      case LifecycleEventOutcome.DeadLetter:
        await this.options.queue.deadLetter(
          message.receiptHandle,
          result.reason ?? 'Agotados los reintentos al resolver destinatarios.',
        )
        this.options.logger.error('catalog_lifecycle_event_dead_lettered', {
          messageId: message.id,
          eventId: result.eventId,
          attempt: result.attempt,
          reason: result.reason,
        })
        return 'dead-lettered'
    }
  }
}
