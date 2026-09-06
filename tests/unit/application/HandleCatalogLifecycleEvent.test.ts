import { describe, expect, it } from '@jest/globals'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
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

  constructor(resolution: ProductOwnersResolution) {
    this.resolution = resolution
  }

  resolveOwners(): Promise<ProductOwnersResolution> {
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

const buildUseCase = (
  resolver: ProductOwnersResolverPort,
): {
  useCase: HandleCatalogLifecycleEvent
  notifications: InMemoryCatalogNotificationRepository
} => {
  const notifications = new InMemoryCatalogNotificationRepository()
  const useCase = new HandleCatalogLifecycleEvent({
    notifications,
    idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
    productOwnersResolver: resolver,
    clock: new SystemClock(),
    idempotencyTtlMs: 60_000,
  })

  return { useCase, notifications }
}

describe('HandleCatalogLifecycleEvent', () => {
  it('CA: suspension crea una notificacion PLAYER por cada propietario resuelto', async () => {
    const { useCase, notifications } = buildUseCase(
      new FakeOwnersResolver({ available: true, playerIds: ['jugador-a', 'jugador-b'] }),
    )

    const result = await useCase.execute(event())

    expect(result.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(result.notificationsCreated).toBe(2)

    const pendingA = await notifications.findPendingForPlayer('jugador-a')
    expect(pendingA).toHaveLength(1)
    expect(pendingA[0]?.description).toBe('Mago Hielo fue suspendido temporalmente')
    expect(pendingA[0]?.productId).toBe('f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd')

    const pendingB = await notifications.findPendingForPlayer('jugador-b')
    expect(pendingB).toHaveLength(1)
  })

  it('CA: reactivacion notifica a quienes poseian el producto', async () => {
    const { useCase, notifications } = buildUseCase(
      new FakeOwnersResolver({ available: true, playerIds: ['jugador-a'] }),
    )

    await useCase.execute(
      event({
        eventId: '0c2e4b7a-1d5f-4a9c-8e3b-5f7a2c9d0e11',
        eventType: 'catalog.product.reactivated',
        data: {
          productId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
          name: 'Guerrero Tanque',
          type: 'HEROE',
          lifecycleStatus: 'ACTIVE',
        },
      }),
    )

    const pending = await notifications.findPendingForPlayer('jugador-a')
    expect(pending[0]?.description).toBe(
      'Guerrero Tanque fue reactivado y vuelve a estar disponible',
    )
  })

  it('inventory.adjusted y premium.configured no dependen de posesion: se registran como GLOBAL', async () => {
    const { useCase, notifications } = buildUseCase(
      new FakeOwnersResolver({ available: true, playerIds: [] }),
    )

    await useCase.execute(
      event({
        eventId: '11111111-1111-4111-8111-111111111111',
        eventType: 'catalog.product.inventory.adjusted',
      }),
    )

    const globalItems = await notifications.findAllGlobal()
    expect(globalItems).toHaveLength(1)
    expect(globalItems[0]?.audience).toBe('GLOBAL')
    expect(globalItems[0]?.playerId).toBeNull()
  })

  it('brecha: suspension/reactivacion sin contrato de propietarios queda RecipientsUnresolved, no se reintenta ni se inventa destinatario', async () => {
    const { useCase, notifications } = buildUseCase(
      new FakeOwnersResolver({ available: false, reason: 'sin contrato' }),
    )

    const result = await useCase.execute(event())

    expect(result.outcome).toBe(LifecycleEventOutcome.RecipientsUnresolved)
    expect(result.notificationsCreated).toBe(0)
    expect(await notifications.findAllGlobal()).toHaveLength(0)
  })

  it('idempotencia: procesar el mismo eventId dos veces no duplica notificaciones', async () => {
    const { useCase, notifications } = buildUseCase(
      new FakeOwnersResolver({ available: true, playerIds: ['jugador-a'] }),
    )

    const first = await useCase.execute(event())
    const second = await useCase.execute(event())

    expect(first.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(second.outcome).toBe(LifecycleEventOutcome.Duplicated)
    expect(await notifications.findPendingForPlayer('jugador-a')).toHaveLength(1)
  })
})
