import { describe, expect, it, jest } from '@jest/globals'
import { InMemoryIdempotencyStore } from '../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryCatalogNotificationRepository } from '../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { SystemClock } from '../../src/adapters/clock/SystemClock.js'
import { RetryPolicy } from '../../src/domain/policies/RetryPolicy.js'
import { PlayerInventoryProductOwnersResolver } from '../../src/adapters/identity/PlayerInventoryProductOwnersResolver.js'
import {
  HandleCatalogLifecycleEvent,
  LifecycleEventOutcome,
} from '../../src/application/use-cases/HandleCatalogLifecycleEvent.js'
import type { CatalogLifecycleEvent } from '../../src/application/dto/CatalogLifecycleEvent.js'

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'
const BASE_URL = 'http://player-inventory.internal:3002'
const SECRET = 'test-only-secret'

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const suspendedEvent = (eventId: string): CatalogLifecycleEvent => ({
  eventId,
  eventType: 'catalog.product.suspended',
  eventVersion: 1,
  aggregateId: PRODUCT_ID,
  occurredAt: '2026-09-06T15:00:00.000Z',
  producer: 'catalog',
  correlationId: 'req-1',
  data: { productId: PRODUCT_ID, name: 'Mago Hielo', type: 'HEROE', lifecycleStatus: 'SUSPENDED' },
})

const buildUseCase = (
  resolver: PlayerInventoryProductOwnersResolver,
  notifications = new InMemoryCatalogNotificationRepository(),
  idempotencyStore = new InMemoryIdempotencyStore(() => Date.now()),
): HandleCatalogLifecycleEvent =>
  new HandleCatalogLifecycleEvent({
    notifications,
    idempotencyStore,
    productOwnersResolver: resolver,
    clock: new SystemClock(),
    retryPolicy: RetryPolicy.create({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 }),
    idempotencyTtlMs: 60_000,
  })

/**
 * Extremo a extremo del tramo nuevo de HU-38: evento de Catalog ->
 * HandleCatalogLifecycleEvent -> PlayerInventoryProductOwnersResolver (HTTP
 * real, contra un Player-Inventory simulado) -> CatalogNotification. No usa
 * el resolver de pruebas (`FakeOwnersResolver`) de
 * HandleCatalogLifecycleEvent.test.ts: aqui se ejercita el adaptador HTTP
 * real, para probar la integracion, no solo el caso de uso en aislamiento.
 */
describe('HandleCatalogLifecycleEvent + PlayerInventoryProductOwnersResolver', () => {
  it('solo los jugadores que Player-Inventory devuelve como propietarios reciben la notificacion PLAYER', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({ productId: PRODUCT_ID, owners: [{ playerId: 'jugador-dueno' }] }),
      ),
    )
    const resolver = new PlayerInventoryProductOwnersResolver({
      baseUrl: BASE_URL,
      secret: SECRET,
      timeoutMs: 1_000,
      fetch: fetchImpl,
    })
    const notifications = new InMemoryCatalogNotificationRepository()
    const useCase = buildUseCase(resolver, notifications)

    const result = await useCase.execute({
      event: suspendedEvent('6a1f9c3e-2b8a-4e7a-9a0f-7d3c9b2e1a44'),
      deliveryAttempt: 1,
    })

    expect(result.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(result.notificationsCreated).toBe(1)

    const forOwner = await notifications.findPendingForPlayer('jugador-dueno')
    expect(forOwner).toHaveLength(1)
    expect(forOwner[0]?.description).toBe('Mago Hielo fue suspendido temporalmente')

    // El jugador que no posee el producto -Player-Inventory nunca lo listo-
    // no recibe ninguna notificacion.
    const forNonOwner = await notifications.findPendingForPlayer('jugador-que-no-lo-tiene')
    expect(forNonOwner).toHaveLength(0)
  })

  it('un fallo de Player-Inventory (5xx) no crea notificaciones, se reencola (no se confirma) y nunca cae a GLOBAL', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 503 })),
    )
    const resolver = new PlayerInventoryProductOwnersResolver({
      baseUrl: BASE_URL,
      secret: SECRET,
      timeoutMs: 1_000,
      fetch: fetchImpl,
    })
    const notifications = new InMemoryCatalogNotificationRepository()
    const idempotencyStore = new InMemoryIdempotencyStore(() => Date.now())
    const useCase = buildUseCase(resolver, notifications, idempotencyStore)

    const result = await useCase.execute({
      event: suspendedEvent('22222222-2222-4222-8222-222222222222'),
      deliveryAttempt: 1,
    })

    expect(result.outcome).toBe(LifecycleEventOutcome.Retry)
    expect(result.notificationsCreated).toBe(0)
    expect(await notifications.findAllGlobal()).toEqual([])
    // Liberada, no confirmada: el mismo eventId puede reservarse de nuevo.
    expect(
      await idempotencyStore.reserve(
        'catalog:lifecycle:catalog.product.suspended:22222222-2222-4222-8222-222222222222',
        60_000,
      ),
    ).toBe(true)
  })

  it('11/12 (integracion): Player-Inventory falla con 500 en el primer intento y se recupera en el segundo -mismo eventId, la notificacion no se pierde', async () => {
    let attempt = 0
    const fetchImpl = jest.fn<typeof fetch>(() => {
      attempt += 1
      if (attempt === 1) {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      return Promise.resolve(
        jsonResponse({ productId: PRODUCT_ID, owners: [{ playerId: 'jugador-a' }] }),
      )
    })
    const resolver = new PlayerInventoryProductOwnersResolver({
      baseUrl: BASE_URL,
      secret: SECRET,
      timeoutMs: 1_000,
      fetch: fetchImpl,
    })
    const notifications = new InMemoryCatalogNotificationRepository()
    const idempotencyStore = new InMemoryIdempotencyStore(() => Date.now())
    const useCase = buildUseCase(resolver, notifications, idempotencyStore)
    const event = suspendedEvent('44444444-4444-4444-8444-444444444444')

    const first = await useCase.execute({ event, deliveryAttempt: 1 })
    expect(first.outcome).toBe(LifecycleEventOutcome.Retry)
    expect(first.notificationsCreated).toBe(0)
    expect(await notifications.findAllGlobal()).toEqual([])
    expect(await notifications.findPendingForPlayer('jugador-a')).toEqual([])

    // Segunda entrega del MISMO eventId (simulando el reencolado de la cola).
    const second = await useCase.execute({ event, deliveryAttempt: 2 })

    expect(second.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(second.notificationsCreated).toBe(1)
    const pending = await notifications.findPendingForPlayer('jugador-a')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.description).toBe('Mago Hielo fue suspendido temporalmente')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('idempotencia: procesar el mismo eventId dos veces contra Player-Inventory real (exito) no duplica la notificacion', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({ productId: PRODUCT_ID, owners: [{ playerId: 'jugador-dueno' }] }),
      ),
    )
    const resolver = new PlayerInventoryProductOwnersResolver({
      baseUrl: BASE_URL,
      secret: SECRET,
      timeoutMs: 1_000,
      fetch: fetchImpl,
    })
    const notifications = new InMemoryCatalogNotificationRepository()
    const useCase = buildUseCase(resolver, notifications)
    const event = suspendedEvent('33333333-3333-4333-8333-333333333333')

    const first = await useCase.execute({ event, deliveryAttempt: 1 })
    const second = await useCase.execute({ event, deliveryAttempt: 2 })

    expect(first.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(second.outcome).toBe(LifecycleEventOutcome.Duplicated)
    expect(await notifications.findPendingForPlayer('jugador-dueno')).toHaveLength(1)
    // La segunda ejecucion no debio volver a llamar a Player-Inventory: la
    // idempotencia se resuelve antes de intentar resolver destinatarios.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
