import { describe, expect, it } from '@jest/globals'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
import { RetryPolicy } from '../../../src/domain/policies/RetryPolicy.js'
import {
  HandleCatalogLifecycleEvent,
  LifecycleEventOutcome,
} from '../../../src/application/use-cases/HandleCatalogLifecycleEvent.js'
import type { CatalogLifecycleEvent } from '../../../src/application/dto/CatalogLifecycleEvent.js'
import type {
  ProductOwnersResolution,
  ProductOwnersResolverPort,
} from '../../../src/application/ports/ProductOwnersResolverPort.js'

class FakeOwnersResolver implements ProductOwnersResolverPort {
  private readonly resolution: ProductOwnersResolution
  calls = 0

  constructor(resolution: ProductOwnersResolution) {
    this.resolution = resolution
  }

  resolveOwners(): Promise<ProductOwnersResolution> {
    this.calls += 1
    return Promise.resolve(this.resolution)
  }
}

const event = (overrides: Partial<CatalogLifecycleEvent> = {}): CatalogLifecycleEvent => ({
  eventId: '6a1f9c3e-2b8a-4e7a-9a0f-7d3c9b2e1a44',
  eventType: 'catalog.product.suspended',
  eventVersion: 1,
  aggregateId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
  occurredAt: '2026-09-06T15:00:00.000Z',
  producer: 'catalog',
  correlationId: 'req-1',
  data: {
    productId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
    name: 'Mago Hielo',
    type: 'HEROE',
    lifecycleStatus: 'SUSPENDED',
  },
  ...overrides,
})

// Misma forma de politica que HandleCatalogProductCreated: 3 intentos, sin
// esperar tiempos reales en las pruebas.
const testRetryPolicy = (maxAttempts = 3): RetryPolicy =>
  RetryPolicy.create({ maxAttempts, baseDelayMs: 10, maxDelayMs: 100 })

const buildUseCase = (
  resolver: ProductOwnersResolverPort,
  retryPolicy: RetryPolicy = testRetryPolicy(),
): {
  useCase: HandleCatalogLifecycleEvent
  notifications: InMemoryCatalogNotificationRepository
  idempotencyStore: InMemoryIdempotencyStore
} => {
  const notifications = new InMemoryCatalogNotificationRepository()
  const idempotencyStore = new InMemoryIdempotencyStore(() => Date.now())
  const useCase = new HandleCatalogLifecycleEvent({
    notifications,
    idempotencyStore,
    productOwnersResolver: resolver,
    clock: new SystemClock(),
    retryPolicy,
    idempotencyTtlMs: 60_000,
  })

  return { useCase, notifications, idempotencyStore }
}

describe('HandleCatalogLifecycleEvent', () => {
  it('1. suspension + PI 200 + 1 owner: processed, confirma idempotencia', async () => {
    const { useCase, notifications, idempotencyStore } = buildUseCase(
      new FakeOwnersResolver({ available: true, playerIds: ['jugador-a'] }),
    )

    const result = await useCase.execute({ event: event(), deliveryAttempt: 1 })

    expect(result.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(result.notificationsCreated).toBe(1)
    const pendingA = await notifications.findPendingForPlayer('jugador-a')
    expect(pendingA).toHaveLength(1)
    expect(pendingA[0]?.description).toBe('Mago Hielo fue suspendido temporalmente')
    // Confirmada: una segunda reserva de la misma clave debe fallar (ya "consumida" como duplicado).
    expect(
      await idempotencyStore.reserve(
        'catalog:lifecycle:catalog.product.suspended:6a1f9c3e-2b8a-4e7a-9a0f-7d3c9b2e1a44',
        60_000,
      ),
    ).toBe(false)
  })

  it('CA: suspension crea una notificacion PLAYER por cada propietario resuelto (multiples)', async () => {
    const { useCase, notifications } = buildUseCase(
      new FakeOwnersResolver({ available: true, playerIds: ['jugador-a', 'jugador-b'] }),
    )

    const result = await useCase.execute({ event: event(), deliveryAttempt: 1 })

    expect(result.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(result.notificationsCreated).toBe(2)
    expect(await notifications.findPendingForPlayer('jugador-a')).toHaveLength(1)
    expect(await notifications.findPendingForPlayer('jugador-b')).toHaveLength(1)
  })

  it('2. suspension + PI 200 + owners=[]: processed, 0 notificaciones, confirma idempotencia (no es un fallo)', async () => {
    const { useCase, notifications } = buildUseCase(
      new FakeOwnersResolver({ available: true, playerIds: [] }),
    )

    const result = await useCase.execute({ event: event(), deliveryAttempt: 1 })

    expect(result.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(result.notificationsCreated).toBe(0)
    expect(await notifications.findAllGlobal()).toEqual([])
  })

  it('CA: reactivacion notifica a quienes poseian el producto', async () => {
    const { useCase, notifications } = buildUseCase(
      new FakeOwnersResolver({ available: true, playerIds: ['jugador-a'] }),
    )

    await useCase.execute({
      event: event({
        eventId: '0c2e4b7a-1d5f-4a9c-8e3b-5f7a2c9d0e11',
        eventType: 'catalog.product.reactivated',
        data: {
          productId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
          name: 'Guerrero Tanque',
          type: 'HEROE',
          lifecycleStatus: 'ACTIVE',
        },
      }),
      deliveryAttempt: 1,
    })

    const pending = await notifications.findPendingForPlayer('jugador-a')
    expect(pending[0]?.description).toBe(
      'Guerrero Tanque fue reactivado y vuelve a estar disponible',
    )
  })

  it('13. inventory.adjusted no llama al resolver de propietarios', async () => {
    const resolver = new FakeOwnersResolver({ available: true, playerIds: [] })
    const { useCase, notifications } = buildUseCase(resolver)

    await useCase.execute({
      event: event({
        eventId: '11111111-1111-4111-8111-111111111111',
        eventType: 'catalog.product.inventory.adjusted',
      }),
      deliveryAttempt: 1,
    })

    expect(resolver.calls).toBe(0)
    const globalItems = await notifications.findAllGlobal()
    expect(globalItems).toHaveLength(1)
    expect(globalItems[0]?.audience).toBe('GLOBAL')
    expect(globalItems[0]?.playerId).toBeNull()
  })

  it('14. premium.configured no llama al resolver de propietarios', async () => {
    const resolver = new FakeOwnersResolver({ available: true, playerIds: [] })
    const { useCase } = buildUseCase(resolver)

    await useCase.execute({
      event: event({
        eventId: '44444444-4444-4444-8444-444444444444',
        eventType: 'catalog.product.premium.configured',
      }),
      deliveryAttempt: 1,
    })

    expect(resolver.calls).toBe(0)
  })

  it('3/4/6. fallo transitorio (timeout/red/5xx) al resolver propietarios: libera idempotencia y pide reintento, NO confirma', async () => {
    const { useCase, notifications, idempotencyStore } = buildUseCase(
      new FakeOwnersResolver({ available: false, reason: 'timeout consultando Player-Inventory' }),
    )

    const result = await useCase.execute({ event: event(), deliveryAttempt: 1 })

    expect(result.outcome).toBe(LifecycleEventOutcome.Retry)
    expect(result.notificationsCreated).toBe(0)
    expect(result.retryDelayMs).not.toBeNull()
    expect(await notifications.findAllGlobal()).toEqual([])
    // Liberada: una nueva reserva de la misma clave debe tener exito.
    expect(
      await idempotencyStore.reserve(
        'catalog:lifecycle:catalog.product.suspended:6a1f9c3e-2b8a-4e7a-9a0f-7d3c9b2e1a44',
        60_000,
      ),
    ).toBe(true)
  })

  it('12. el retraso de reintento usa RetryPolicy real (retroceso exponencial), no un numero inventado', async () => {
    const { useCase } = buildUseCase(
      new FakeOwnersResolver({ available: false, reason: 'x' }),
      RetryPolicy.create({ maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 }),
    )

    const result = await useCase.execute({ event: event(), deliveryAttempt: 2 })

    expect(result.outcome).toBe(LifecycleEventOutcome.Retry)
    // base * 2^(attempt-1) = 1000 * 2^1 = 2000
    expect(result.retryDelayMs).toBe(2_000)
  })

  it('11. intentos agotados: dead-letter, confirma idempotencia (mismo criterio que HandleCatalogProductCreated)', async () => {
    const { useCase, idempotencyStore } = buildUseCase(
      new FakeOwnersResolver({ available: false, reason: 'Player-Inventory no disponible' }),
      testRetryPolicy(1),
    )

    const result = await useCase.execute({ event: event(), deliveryAttempt: 1 })

    expect(result.outcome).toBe(LifecycleEventOutcome.DeadLetter)
    expect(result.notificationsCreated).toBe(0)
    // Confirmada: una redelivery del mismo eventId no debe volver a reservarse.
    expect(
      await idempotencyStore.reserve(
        'catalog:lifecycle:catalog.product.suspended:6a1f9c3e-2b8a-4e7a-9a0f-7d3c9b2e1a44',
        60_000,
      ),
    ).toBe(false)
  })

  it('9. idempotencia: procesar el mismo eventId dos veces (exito) no duplica notificaciones', async () => {
    const { useCase, notifications } = buildUseCase(
      new FakeOwnersResolver({ available: true, playerIds: ['jugador-a'] }),
    )

    const first = await useCase.execute({ event: event(), deliveryAttempt: 1 })
    const second = await useCase.execute({ event: event(), deliveryAttempt: 2 })

    expect(first.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(second.outcome).toBe(LifecycleEventOutcome.Duplicated)
    expect(await notifications.findPendingForPlayer('jugador-a')).toHaveLength(1)
  })

  it('10. un fallo transitorio no queda bloqueado como "duplicated" en el segundo intento: se procesa de verdad', async () => {
    let attempt = 0
    class FlakyResolver implements ProductOwnersResolverPort {
      resolveOwners(): Promise<ProductOwnersResolution> {
        attempt += 1
        return Promise.resolve(
          attempt === 1
            ? { available: false, reason: '503' }
            : { available: true, playerIds: ['jugador-a'] },
        )
      }
    }
    const { useCase, notifications } = buildUseCase(new FlakyResolver())

    const first = await useCase.execute({ event: event(), deliveryAttempt: 1 })
    expect(first.outcome).toBe(LifecycleEventOutcome.Retry)

    const second = await useCase.execute({ event: event(), deliveryAttempt: 2 })
    expect(second.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(second.notificationsCreated).toBe(1)
    expect(await notifications.findPendingForPlayer('jugador-a')).toHaveLength(1)
  })

  it('8. segundo intento con Player-Inventory recuperado crea la notificacion', async () => {
    let calls = 0
    class RecoveringResolver implements ProductOwnersResolverPort {
      resolveOwners(): Promise<ProductOwnersResolution> {
        calls += 1
        return Promise.resolve(
          calls < 2
            ? { available: false, reason: 'red' }
            : { available: true, playerIds: ['jugador-a'] },
        )
      }
    }
    const { useCase, notifications } = buildUseCase(new RecoveringResolver())

    await useCase.execute({ event: event(), deliveryAttempt: 1 })
    const result = await useCase.execute({ event: event(), deliveryAttempt: 2 })

    expect(result.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(await notifications.findPendingForPlayer('jugador-a')).toHaveLength(1)
  })

  it('resolver sin configurar (UnavailableProductOwnersResolver) sigue la misma ruta reintentable, nunca GLOBAL', async () => {
    const { useCase, notifications } = buildUseCase({
      resolveOwners: () =>
        Promise.resolve({
          available: false,
          reason: 'Player-Inventory no expone todavia un contrato.',
        }),
    })

    const result = await useCase.execute({ event: event(), deliveryAttempt: 1 })

    expect(result.outcome).toBe(LifecycleEventOutcome.Retry)
    expect(await notifications.findAllGlobal()).toEqual([])
  })
})
