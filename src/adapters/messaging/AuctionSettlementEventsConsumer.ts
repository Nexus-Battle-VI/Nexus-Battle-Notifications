import type { MessageQueuePort } from '../../application/ports/MessageQueuePort.js'
import type { HandleAuctionSettledEvent } from '../../application/use-cases/HandleAuctionSettledEvent.js'
import type { Logger } from '../../infrastructure/observability/logger.js'
import { parseAuctionSettledEventV1 } from './AuctionSettledEventParser.js'

export class AuctionSettlementEventsConsumer {
  private readonly options: {
    readonly queue: MessageQueuePort
    readonly useCase: HandleAuctionSettledEvent
    readonly logger: Logger
    readonly batchSize: number
  }
  constructor(options: {
    readonly queue: MessageQueuePort
    readonly useCase: HandleAuctionSettledEvent
    readonly logger: Logger
    readonly batchSize: number
  }) {
    this.options = options
  }

  async processBatch(): Promise<{ readonly received: number; readonly processed: number }> {
    const messages = await this.options.queue.receive(this.options.batchSize)
    let processed = 0
    for (const message of messages) {
      try {
        const event = parseAuctionSettledEventV1(message.body)
        this.options.logger.info('auction_settlement_notification_received', {
          messageId: message.id,
          eventId: event.eventId,
        })
        const result = await this.options.useCase.execute(event)
        await this.options.queue.acknowledge(message.receiptHandle)
        this.options.logger.info('auction_settlement_message_deleted', {
          messageId: message.id,
          eventId: event.eventId,
          ...result,
        })
        processed += 1
      } catch (error: unknown) {
        this.options.logger.error('auction_settlement_notification_failed', {
          messageId: message.id,
          reason: error instanceof Error ? error.message : 'Fallo desconocido.',
        })
        // No acknowledge/requeue here: Standard SQS redrive retries this exact delivery.
        throw error
      }
    }
    return { received: messages.length, processed }
  }
}
