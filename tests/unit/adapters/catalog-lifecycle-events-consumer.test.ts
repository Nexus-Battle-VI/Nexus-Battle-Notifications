import { describe, expect, it } from '@jest/globals'
import { InMemoryMessageQueue } from '../../../src/adapters/messaging/InMemoryMessageQueue.js'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
import { RetryPolicy } from '../../../src/domain/policies/RetryPolicy.js'
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
  maxAttempts = 3,
): { consumer: CatalogLifecycleEventsConsumer; queue: InMemoryMessageQueue } => {
  const queue = new InMemoryMessageQueue(() => Date.now())
  const useCase = new HandleCatalogLifecycleEvent({
    notifications: new InMemoryCatalogNotificationRepository(),
    idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
    productOwnersResolver: resolver,
    clock: new SystemClock(),
    retryPolicy: RetryPolicy.create({ maxAttempts, baseDelayMs: 10, maxDelayMs: 100 }),
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

const suspendedBody = (overrides: Record<string, unknown> = {}): string =>
  validBody({
    eventType: 'catalog.product.suspended',
    data: {
      productId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
      name: 'Mago Hielo',
      type: 'HEROE',
      lifecycleStatus: 'SUSPENDED',
    },
    ...overrides,
  })

describe('CatalogLifecycleEventsConsumer', () => {
  it('procesa un evento valido y lo confirma (no queda en vuelo)', async () => {
    const { consumer, queue } = buildConsumer()
    queue.publish(validBody())

    const summary = await consumer.processBatch()

    expect(summary).toMatchObject({ received: 1, processed: 1, requeued: 0, deadLettered: 0 })
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

  it('5. un fallo transitorio al resolver propietarios se reencola (NO se confirma), no queda en vuelo', async () => {
    const { consumer, queue } = buildConsumer(
      new FakeOwnersResolver({ available: false, reason: 'HTTP 500 de Player-Inventory' }),
    )
    queue.publish(suspendedBody({ eventId: '22222222-2222-4222-8222-222222222222' }))

    const summary = await consumer.processBatch()

    expect(summary.requeued).toBe(1)
    expect(summary.processed).toBe(0)
    expect(summary.deadLettered).toBe(0)
    expect(queue.inFlightCount).toBe(0)
    // Reencolado, no perdido: sigue pendiente en la cola.
    expect(queue.pendingCount).toBe(1)
  })

  it('7/11. primer intento falla (requeue) y, agotados los intentos, termina en dead-letter', async () => {
    const resolver = new FakeOwnersResolver({ available: false, reason: 'Player-Inventory caido' })
    const { consumer, queue } = buildConsumer(resolver, 2)
    queue.publish(suspendedBody({ eventId: '33333333-3333-4333-8333-333333333333' }))

    const first = await consumer.processBatch()
    expect(first.requeued).toBe(1)
    expect(queue.pendingCount).toBe(1)

    // El reencolado se hace visible tras retryBaseDelayMs (10ms en esta prueba).
    await new Promise((resolve) => setTimeout(resolve, 20))

    // El segundo intento agota maxAttempts=2 y debe salir del flujo por dead-letter.
    const second = await consumer.processBatch()
    expect(second.deadLettered).toBe(1)
    expect(second.requeued).toBe(0)
    expect(queue.deadLettered).toHaveLength(1)
    expect(queue.pendingCount).toBe(0)
  })

  it('inventory.adjusted y premium.configured procesan normalmente sin llamar al resolver', async () => {
    const resolver = new FakeOwnersResolver({ available: false, reason: 'no deberia llamarse' })
    let calls = 0
    const spyResolver: ProductOwnersResolverPort = {
      resolveOwners: () => {
        calls += 1
        return resolver.resolveOwners()
      },
    }
    const { consumer, queue } = buildConsumer(spyResolver)
    queue.publish(validBody())

    const summary = await consumer.processBatch()

    expect(summary.processed).toBe(1)
    expect(calls).toBe(0)
  })
})
