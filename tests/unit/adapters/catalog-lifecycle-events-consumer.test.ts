import { describe, expect, it } from '@jest/globals'
import { InMemoryMessageQueue } from '../../../src/adapters/messaging/InMemoryMessageQueue.js'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
import { CatalogLifecycleEventsConsumer } from '../../../src/adapters/messaging/CatalogLifecycleEventsConsumer.js'
import { HandleCatalogLifecycleEvent } from '../../../src/application/use-cases/HandleCatalogLifecycleEvent.js'
import { createLogger } from '../../../src/infrastructure/observability/logger.js'
import type {
  ProductOwnersResolution,
  ProductOwnersResolverPort,
} from '../../../src/application/ports/ProductOwnersResolverPort.js'

class FakeOwnersResolver implements ProductOwnersResolverPort {
  private readonly resolution: ProductOwnersResolution

  constructor(resolution: ProductOwnersResolution) {
    this.resolution = resolution
  }

  resolveOwners(): Promise<ProductOwnersResolution> {
    return Promise.resolve(this.resolution)
  }
}

const validBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    eventId: '6a1f9c3e-2b8a-4e7a-9a0f-7d3c9b2e1a44',
    eventType: 'catalog.product.inventory.adjusted',
    eventVersion: 1,
    aggregateId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
    occurredAt: '2026-09-06T15:00:00Z',
    producer: 'catalog',
    correlationId: 'req-1',
    data: {
      productId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
      name: 'Armadura de Escamas',
      type: 'ARMADURA',
      lifecycleStatus: 'ACTIVE',
    },
    ...overrides,
  })

const buildConsumer = (
  resolver: ProductOwnersResolverPort = new FakeOwnersResolver({ available: true, playerIds: [] }),
): { consumer: CatalogLifecycleEventsConsumer; queue: InMemoryMessageQueue } => {
  const queue = new InMemoryMessageQueue(() => Date.now())
  const useCase = new HandleCatalogLifecycleEvent({
    notifications: new InMemoryCatalogNotificationRepository(),
    idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
    productOwnersResolver: resolver,
    clock: new SystemClock(),
    idempotencyTtlMs: 60_000,
  })
  const consumer = new CatalogLifecycleEventsConsumer({
    queue,
    useCase,
    logger: createLogger({ level: 'error', service: 'test', version: '0' }),
    batchSize: 10,
  })

  return { consumer, queue }
}

describe('CatalogLifecycleEventsConsumer', () => {
  it('procesa un evento valido y lo confirma (no queda en vuelo)', async () => {
    const { consumer, queue } = buildConsumer()
    queue.publish(validBody())

    const summary = await consumer.processBatch()

    expect(summary).toMatchObject({ received: 1, processed: 1, deadLettered: 0 })
    expect(queue.inFlightCount).toBe(0)
  })

  it('un evento invalido se manda a la cola de fallidos sin detener el consumidor', async () => {
    const { consumer, queue } = buildConsumer()
    queue.publish('{esto no es json')
    queue.publish(validBody({ eventId: '11111111-1111-4111-8111-111111111111' }))

    const summary = await consumer.processBatch()

    expect(summary.received).toBe(2)
    expect(summary.deadLettered).toBe(1)
    expect(summary.processed).toBe(1)
    expect(queue.deadLettered).toHaveLength(1)
  })

  it('un evento con destinatarios sin resolver se confirma (no se reintenta indefinidamente) y queda registrado', async () => {
    const { consumer, queue } = buildConsumer(
      new FakeOwnersResolver({ available: false, reason: 'sin contrato' }),
    )
    queue.publish(
      validBody({
        eventType: 'catalog.product.suspended',
        eventId: '22222222-2222-4222-8222-222222222222',
        data: {
          productId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
          name: 'Mago Hielo',
          type: 'HEROE',
          lifecycleStatus: 'SUSPENDED',
        },
      }),
    )

    const summary = await consumer.processBatch()

    expect(summary.recipientsUnresolved).toBe(1)
    expect(queue.inFlightCount).toBe(0)
  })
})
