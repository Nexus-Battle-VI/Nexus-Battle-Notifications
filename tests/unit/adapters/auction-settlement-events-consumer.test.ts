import { describe, expect, it } from '@jest/globals'
import { AuctionSettlementEventsConsumer } from '../../../src/adapters/messaging/AuctionSettlementEventsConsumer.js'
import { HandleAuctionSettledEvent } from '../../../src/application/use-cases/HandleAuctionSettledEvent.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import type {
  MessageQueuePort,
  QueueMessage,
} from '../../../src/application/ports/MessageQueuePort.js'
import { createLogger } from '../../../src/infrastructure/observability/logger.js'

const body = JSON.stringify({
  eventId: 'evt-1',
  eventType: 'auction.settled',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt: '2026-01-01T00:00:00.000Z',
  producer: 'auction',
  correlationId: 'corr',
  data: {
    auctionId: 'auction-1',
    productId: 'product-1',
    sellerId: 'seller',
    resultType: 'WITHOUT_BIDS',
    settledAt: '2026-01-01T00:00:00.000Z',
  },
})
class Queue implements MessageQueuePort {
  acked = 0
  failAck = false
  readonly message: QueueMessage
  constructor(message: QueueMessage) {
    this.message = message
  }
  receive(): Promise<readonly QueueMessage[]> {
    return Promise.resolve([this.message])
  }
  acknowledge(): Promise<void> {
    this.acked += 1
    if (this.failAck) return Promise.reject(new Error('delete failed'))
    return Promise.resolve()
  }
  requeue(): Promise<void> {
    return Promise.resolve()
  }
  deadLetter(): Promise<void> {
    return Promise.resolve()
  }
}
const consumer = (
  queue: Queue,
  notifications: InMemoryCatalogNotificationRepository,
): AuctionSettlementEventsConsumer =>
  new AuctionSettlementEventsConsumer({
    queue,
    useCase: new HandleAuctionSettledEvent({
      notifications,
      clock: { now: (): Date => new Date() },
    }),
    logger: createLogger({ level: 'error', service: 'test', version: '0' }),
    batchSize: 1,
  })
describe('AuctionSettlementEventsConsumer', () => {
  it('acknowledges only after persistence and replay after ack failure does not duplicate', async (): Promise<void> => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const queue = new Queue({ id: 'm', body, receiptHandle: 'r', receivedCount: 1 })
    queue.failAck = true
    await expect(consumer(queue, notifications).processBatch()).rejects.toThrow('delete failed')
    expect(await notifications.findHistoryForPlayer('seller')).toHaveLength(1)
    queue.failAck = false
    await consumer(queue, notifications).processBatch()
    expect(queue.acked).toBe(2)
    expect(await notifications.findHistoryForPlayer('seller')).toHaveLength(1)
  })
  it('does not acknowledge invalid JSON or invalid contract', async (): Promise<void> => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const queue = new Queue({ id: 'm', body: '{', receiptHandle: 'r', receivedCount: 1 })
    await expect(consumer(queue, notifications).processBatch()).rejects.toThrow()
    expect(queue.acked).toBe(0)
    const invalid = new Queue({
      id: 'm2',
      body: body.replace('"eventVersion":1', '"eventVersion":2'),
      receiptHandle: 'r2',
      receivedCount: 1,
    })
    await expect(consumer(invalid, notifications).processBatch()).rejects.toThrow()
    expect(invalid.acked).toBe(0)
  })
})
