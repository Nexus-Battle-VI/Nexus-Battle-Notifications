import { describe, expect, it } from '@jest/globals'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
import {
  HandleCatalogProductCreatedInApp,
  InAppCreatedOutcome,
} from '../../../src/application/use-cases/HandleCatalogProductCreatedInApp.js'
import type { CatalogProductCreatedEvent } from '../../../src/application/dto/CatalogProductCreatedEvent.js'

const event = (): CatalogProductCreatedEvent => ({
  eventId: '2b772782-8814-4c1c-b3ae-a1efca31826d',
  eventType: 'catalog.product.created',
  eventVersion: 1,
  aggregateId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
  occurredAt: '2026-09-02T20:30:00.000Z',
  producer: 'catalog',
  correlationId: 'req-6d87cfc4',
  data: {
    productId: 'f4b09d5f-a47d-43aa-98c0-dbe7a6bd35dd',
    name: 'Espada de Fuego',
    type: 'ARMA',
    lifecycleStatus: 'ACTIVE',
    imageUrl: 'https://api.example.test/assets/sword.png',
  },
})

describe('HandleCatalogProductCreatedInApp', () => {
  it('registra la creacion como notificacion GLOBAL en lenguaje de jugador, sin IDs tecnicos en la descripcion', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const useCase = new HandleCatalogProductCreatedInApp({
      notifications,
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      clock: new SystemClock(),
      idempotencyTtlMs: 60_000,
    })

    const result = await useCase.execute(event())

    expect(result.outcome).toBe(InAppCreatedOutcome.Processed)

    const [notification] = await notifications.findAllGlobal()
    expect(notification?.audience).toBe('GLOBAL')
    expect(notification?.description).toBe('Nuevo producto disponible: Espada de Fuego')
    expect(notification?.description).not.toMatch(/f4b09d5f/)
  })

  it('idempotencia: el mismo evento procesado dos veces no duplica la notificacion', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const useCase = new HandleCatalogProductCreatedInApp({
      notifications,
      idempotencyStore: new InMemoryIdempotencyStore(() => Date.now()),
      clock: new SystemClock(),
      idempotencyTtlMs: 60_000,
    })

    await useCase.execute(event())
    const second = await useCase.execute(event())

    expect(second.outcome).toBe(InAppCreatedOutcome.Duplicated)
    expect(await notifications.findAllGlobal()).toHaveLength(1)
  })

  it('usa una clave de idempotencia distinta de la del correo transaccional (no compiten por la misma reserva)', async () => {
    const idempotencyStore = new InMemoryIdempotencyStore(() => Date.now())
    const notifications = new InMemoryCatalogNotificationRepository()
    const useCase = new HandleCatalogProductCreatedInApp({
      notifications,
      idempotencyStore,
      clock: new SystemClock(),
      idempotencyTtlMs: 60_000,
    })

    await useCase.execute(event())

    // La clave que usa el correo transaccional (HandleCatalogProductCreated)
    // sigue libre: no fue tomada por la reaccion in-app.
    const emailKeyStillFree = await idempotencyStore.reserve(
      `catalog:product:created:${event().eventId}`,
      60_000,
    )
    expect(emailKeyStillFree).toBe(true)
  })
})
