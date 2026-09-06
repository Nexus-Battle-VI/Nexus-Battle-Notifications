import { describe, expect, it, jest } from '@jest/globals'
import { InMemoryIdempotencyStore } from '../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryCatalogNotificationRepository } from '../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { SystemClock } from '../../src/adapters/clock/SystemClock.js'
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
    const useCase = new HandleCatalogLifecycleEvent({
      notifications,
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      productOwnersResolver: resolver,
      clock: new SystemClock(),
      idempotencyTtlMs: 60_000,
    })

    const result = await useCase.execute(suspendedEvent('6a1f9c3e-2b8a-4e7a-9a0f-7d3c9b2e1a44'))

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

  it('un fallo de Player-Inventory (5xx) no crea notificaciones y queda como recipients-unresolved, nunca como GLOBAL', async () => {
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
    const useCase = new HandleCatalogLifecycleEvent({
      notifications,
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      productOwnersResolver: resolver,
      clock: new SystemClock(),
      idempotencyTtlMs: 60_000,
    })

    const result = await useCase.execute(suspendedEvent('22222222-2222-4222-8222-222222222222'))

    expect(result.outcome).toBe(LifecycleEventOutcome.RecipientsUnresolved)
    expect(result.notificationsCreated).toBe(0)
    expect(await notifications.findAllGlobal()).toEqual([])
  })

  it('idempotencia: procesar el mismo eventId dos veces contra Player-Inventory real no duplica la notificacion', async () => {
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
    const idempotencyStore = new InMemoryIdempotencyStore(() => Date.now())
    const useCase = new HandleCatalogLifecycleEvent({
      notifications,
      idempotencyStore,
      productOwnersResolver: resolver,
      clock: new SystemClock(),
      idempotencyTtlMs: 60_000,
    })
    const event = suspendedEvent('33333333-3333-4333-8333-333333333333')

    const first = await useCase.execute(event)
    const second = await useCase.execute(event)

    expect(first.outcome).toBe(LifecycleEventOutcome.Processed)
    expect(second.outcome).toBe(LifecycleEventOutcome.Duplicated)
    expect(await notifications.findPendingForPlayer('jugador-dueno')).toHaveLength(1)
    // La segunda ejecucion no debio volver a llamar a Player-Inventory: la
    // idempotencia se resuelve antes de intentar resolver destinatarios.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
