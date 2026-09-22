import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { beforeAll, afterAll, describe, expect, it } from '@jest/globals'
import { createCatalogNotificationsServer } from '../../src/infrastructure/http/catalog-notifications-server.js'
import { createLogger } from '../../src/infrastructure/observability/logger.js'
import { InMemoryCatalogNotificationRepository } from '../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { InMemoryGlobalNotificationReceiptRepository } from '../../src/adapters/persistence/InMemoryGlobalNotificationReceiptRepository.js'
import { InMemoryBannerRepository } from '../../src/adapters/persistence/InMemoryBannerRepository.js'
import { CatalogNotification } from '../../src/domain/entities/CatalogNotification.js'
import { BannerEntry } from '../../src/domain/entities/BannerEntry.js'
import { CatalogChangeType } from '../../src/domain/entities/CatalogChangeType.js'
import { SystemClock } from '../../src/adapters/clock/SystemClock.js'
import { GetPlayerNotifications } from '../../src/application/use-cases/GetPlayerNotifications.js'
import { MarkNotificationsRead } from '../../src/application/use-cases/MarkNotificationsRead.js'
import { CreateBannerEntry } from '../../src/application/use-cases/CreateBannerEntry.js'
import { ListBanners } from '../../src/application/use-cases/ListBanners.js'
import { HandleAuctionWatchlistEvent } from '../../src/application/use-cases/HandleAuctionWatchlistEvent.js'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/identity/internal-signature.js'
import {
  IdentityVerificationError,
  Role,
  type IdentityVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/IdentityVerifierPort.js'

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-jugador-a': { subject: 'jugador-a', roles: new Set([Role.Player]) },
  'token-jugador-b': { subject: 'jugador-b', roles: new Set([Role.Player]) },
  'token-admin': { subject: 'admin-1', roles: new Set([Role.Player, Role.Administrator]) },
  'token-super-admin': {
    subject: 'super-admin-1',
    roles: new Set([Role.Player, Role.SuperAdministrator]),
  },
}

const stubIdentityVerifier: IdentityVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new IdentityVerificationError())
      : Promise.resolve(identity)
  },
}

describe('Superficie HTTP HU-38 (notificaciones + banner)', () => {
  const internalSecret = 'test-internal-secret'
  let server: Server
  let url: string
  let notifications: InMemoryCatalogNotificationRepository
  let globalReceipts: InMemoryGlobalNotificationReceiptRepository
  let banners: InMemoryBannerRepository

  beforeAll(async () => {
    notifications = new InMemoryCatalogNotificationRepository()
    globalReceipts = new InMemoryGlobalNotificationReceiptRepository()
    banners = new InMemoryBannerRepository()
    const clock = new SystemClock()

    server = createCatalogNotificationsServer({
      port: 0,
      identityVerifier: stubIdentityVerifier,
      getPlayerNotifications: new GetPlayerNotifications({ notifications, globalReceipts }),
      markNotificationsRead: new MarkNotificationsRead({ notifications, globalReceipts, clock }),
      createBannerEntry: new CreateBannerEntry({ banners, clock }),
      listBanners: new ListBanners({ banners, clock }),
      handleAuctionWatchlistEvent: new HandleAuctionWatchlistEvent(notifications, clock),
      internalSharedSecret: internalSecret,
      logger: createLogger({ level: 'error', service: 'test', version: 'test' }),
    })
    await once(server, 'listening')
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })

  const get = (path: string, token?: string): Promise<Response> =>
    fetch(`${url}${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    })

  const post = (path: string, token: string | undefined, body: unknown): Promise<Response> =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    })

  /** Emula el adaptador productor de Auction con el contrato HMAC real. */
  const postAuctionEvent = (body: unknown, validSignature = true): Promise<Response> => {
    const path = '/api/internal/v1/notifications/auction/watchlist-events'
    const timestamp = String(Date.now())
    const signature = signInternalRequest(internalSecret, {
      service: 'auction',
      method: 'POST',
      path,
      timestamp,
      body,
    })
    return fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_SERVICE_HEADER]: 'auction',
        [INTERNAL_TIMESTAMP_HEADER]: timestamp,
        [INTERNAL_SIGNATURE_HEADER]: validSignature ? signature : 'invalid',
      },
      body: JSON.stringify(body),
    })
  }

  it('acepta un evento firmado de Auction y rechaza replays sin duplicar', async (): Promise<void> => {
    const event = {
      eventId: 'auction-http-event-1',
      eventType: 'auction.watchlist.changed.v1',
      auctionId: 'auction-1',
      recipientPlayerIds: ['jugador-auction-test'],
      changeType: 'LEADING_BID_CHANGED',
      occurredAt: new Date().toISOString(),
    }
    expect((await postAuctionEvent(event)).status).toBe(200)
    const replay = await postAuctionEvent(event)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ status: 'duplicated', created: 0 })
    const pending = await notifications.findPendingForPlayer('jugador-auction-test')
    expect(pending.filter((item) => item.sourceEventId === event.eventId)).toHaveLength(1)
  })

  it('rechaza eventos de Auction con firma inválida', async (): Promise<void> => {
    const response = await postAuctionEvent({}, false)
    expect(response.status).toBe(401)
  })

  it('GET /api/v1/notifications/me/pending sin testimonio es 401', async () => {
    const response = await get('/api/v1/notifications/me/pending')
    expect(response.status).toBe(401)
  })

  it('GET /api/v1/notifications/me/pending con testimonio invalido es 401', async () => {
    const response = await get('/api/v1/notifications/me/pending', 'token-que-no-existe')
    expect(response.status).toBe(401)
  })

  it('aislamiento: el jugador A nunca ve las notificaciones del jugador B', async () => {
    const forB = CatalogNotification.create({
      changeType: CatalogChangeType.ProductSuspended,
      description: 'Mago Hielo fue suspendido temporalmente',
      productId: 'mago-hielo',
      implementedAt: new Date(),
      sourceEventId: 'evt-aislamiento-1',
      sourceEventType: 'catalog.product.suspended',
      playerId: 'jugador-b',
      now: new Date(),
    })
    await notifications.save(forB)

    const asA = await get('/api/v1/notifications/me/pending', 'token-jugador-a')
    const bodyA = (await asA.json()) as { items: unknown[] }
    expect(bodyA.items).toEqual([])

    const asB = await get('/api/v1/notifications/me/pending', 'token-jugador-b')
    const bodyB = (await asB.json()) as { items: unknown[] }
    expect(bodyB.items).toHaveLength(1)
  })

  it('jugador A no puede marcar como leida una notificacion de B (no cambia de estado)', async () => {
    const forB = CatalogNotification.create({
      changeType: CatalogChangeType.ProductReactivated,
      description: 'Guerrero Tanque fue reactivado y vuelve a estar disponible',
      productId: 'guerrero-tanque',
      implementedAt: new Date(),
      sourceEventId: 'evt-aislamiento-2',
      sourceEventType: 'catalog.product.reactivated',
      playerId: 'jugador-b',
      now: new Date(),
    })
    await notifications.save(forB)

    const response = await post('/api/v1/notifications/me/read', 'token-jugador-a', {
      notificationIds: [forB.id],
    })
    expect(response.status).toBe(200)

    const persisted = await notifications.findById(forB.id)
    expect(persisted?.readStatus).toBe('PENDING')
  })

  it('GET /api/v1/banners es publico y solo devuelve entradas vigentes', async () => {
    const now = new Date()
    await banners.save(
      BannerEntry.create({
        title: 'Vigente',
        content: 'x',
        publishAt: new Date(now.getTime() - 1000),
        expiresAt: new Date(now.getTime() + 1000 * 60 * 60),
        createdBy: 'admin-1',
        now,
      }),
    )

    const response = await get('/api/v1/banners')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: { title: string }[] }
    expect(body.items.some((item) => item.title === 'Vigente')).toBe(true)
  })

  it('POST /api/v1/admin/banners rechaza a un Player con 403', async () => {
    const response = await post('/api/v1/admin/banners', 'token-jugador-a', {
      title: 'x',
      content: 'y',
      publishAt: '2026-08-21T00:00:00.000Z',
      expiresAt: '2026-08-23T00:00:00.000Z',
    })
    expect(response.status).toBe(403)
  })

  it('POST /api/v1/admin/banners permite a Administrator y a Super Administrator', async () => {
    const asAdmin = await post('/api/v1/admin/banners', 'token-admin', {
      title: 'Anuncio Admin',
      content: 'y',
      publishAt: '2026-08-21T00:00:00.000Z',
      expiresAt: '2026-08-23T00:00:00.000Z',
    })
    expect(asAdmin.status).toBe(201)

    const asSuperAdmin = await post('/api/v1/admin/banners', 'token-super-admin', {
      title: 'Anuncio Super Admin',
      content: 'y',
      publishAt: '2026-08-21T00:00:00.000Z',
      expiresAt: '2026-08-23T00:00:00.000Z',
    })
    expect(asSuperAdmin.status).toBe(201)
  })

  it('POST /api/v1/admin/banners rechaza fechas invalidas con 400 y no persiste', async () => {
    const before = (await banners.findAll()).length

    const response = await post('/api/v1/admin/banners', 'token-admin', {
      title: 'x',
      content: 'y',
      publishAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-08-20T00:00:00.000Z',
    })

    expect(response.status).toBe(400)
    expect(await banners.findAll()).toHaveLength(before)
  })

  it('GET /api/v1/admin/banners rechaza a un Player y permite a un Administrator ver todo (incluidas no vigentes)', async () => {
    const asPlayer = await get('/api/v1/admin/banners', 'token-jugador-a')
    expect(asPlayer.status).toBe(403)

    const asAdmin = await get('/api/v1/admin/banners', 'token-admin')
    expect(asAdmin.status).toBe(200)
    const body = (await asAdmin.json()) as { items: unknown[] }
    expect(body.items.length).toBeGreaterThan(0)
  })
})
