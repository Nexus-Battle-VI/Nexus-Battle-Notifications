import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { InMemoryIdempotencyStore } from '../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { signInternalRequest } from '../../src/adapters/identity/internal-signature.js'
import { InMemoryCatalogNotificationRepository } from '../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { SystemClock } from '../../src/adapters/clock/SystemClock.js'
import { CreateAuctionOutbidNotification } from '../../src/application/use-cases/CreateAuctionOutbidNotification.js'
import { CatalogChangeType } from '../../src/domain/entities/CatalogChangeType.js'
import {
  AUCTION_OUTBID_PATH,
  createAuctionOutbidServer,
} from '../../src/infrastructure/http/auction-outbid-server.js'
import { createLogger } from '../../src/infrastructure/observability/logger.js'

const secret = 'auction-outbid-test-secret'

const payload = {
  notificationId: 'operation-63-5:outbid',
  operationId: 'operation-63-5',
  recipientPlayerId: 'player-previous-leader',
  auctionId: 'auction-63-5',
  outbidBidId: 'bid-previous',
  winningBidId: 'bid-new-leader',
  winningBidderId: 'player-new-leader',
  winningAmountCredits: 75,
  occurredAt: '2026-09-22T02:00:00.000Z',
}

describe('HTTP interno HU-63.5 - puja superada', () => {
  let server: Server
  let url: string
  let notifications: InMemoryCatalogNotificationRepository

  beforeAll(async () => {
    notifications = new InMemoryCatalogNotificationRepository()

    const clock = new SystemClock()

    const idempotencyStore = new InMemoryIdempotencyStore(() => clock.now().getTime())

    const useCase = new CreateAuctionOutbidNotification({
      notifications,
      idempotencyStore,
      clock,
      idempotencyTtlMs: 86_400_000,
    })

    server = createAuctionOutbidServer({
      port: 0,
      sharedSecret: secret,
      useCase,
      logger: createLogger({
        level: 'error',
        service: 'test',
        version: 'test',
      }),
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

  const post = (
    body: unknown = payload,
    service = 'auction',
    timestamp = String(Date.now()),
  ): Promise<Response> => {
    const signature = signInternalRequest(secret, {
      service,
      method: 'POST',
      path: AUCTION_OUTBID_PATH,
      timestamp,
      body,
    })

    return fetch(url + AUCTION_OUTBID_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service': service,
        'x-internal-timestamp': timestamp,
        'x-internal-signature': signature,
      },
      body: JSON.stringify(body),
    })
  }

  it('rechaza llamadas sin identidad interna valida', async () => {
    const withoutSignature = await fetch(url + AUCTION_OUTBID_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    expect(withoutSignature.status).toBe(401)

    expect((await post(payload, 'commerce')).status).toBe(401)

    expect((await post(payload, 'auction', '0')).status).toBe(401)
  })

  it('crea la notificacion para el postor desplazado', async () => {
    const response = await post()

    expect(response.status).toBe(201)

    expect(await response.json()).toEqual({
      notificationId: payload.notificationId,
      status: 'created',
    })

    const pending = await notifications.findPendingForPlayer(payload.recipientPlayerId)

    expect(pending).toHaveLength(1)

    expect(pending[0]?.changeType).toBe(CatalogChangeType.AuctionBidOutbid)

    expect(pending[0]?.playerId).toBe(payload.recipientPlayerId)

    expect(pending[0]?.description).toContain(payload.auctionId)

    expect(pending[0]?.description).toContain(String(payload.winningAmountCredits))

    expect(pending[0]?.sourceEventType).toBe('auction.bid.outbid.v1')
  })

  it('un replay no crea una segunda notificacion', async () => {
    const response = await post()

    expect(response.status).toBe(200)

    expect(await response.json()).toEqual({
      notificationId: payload.notificationId,
      status: 'duplicated',
    })

    const pending = await notifications.findPendingForPlayer(payload.recipientPlayerId)

    expect(pending).toHaveLength(1)
  })

  it('rechaza payload invalido', async () => {
    const invalid = {
      ...payload,
      winningAmountCredits: 0,
    }

    const response = await post(invalid)

    expect(response.status).toBe(400)
  })

  it('un fallo temporal responde 503 y permite un reintento posterior', async () => {
    const retryPayload = {
      ...payload,
      notificationId: 'operation-retry:outbid',
      operationId: 'operation-retry',
      winningBidId: 'bid-retry',
    }

    const saveSpy = jest.spyOn(notifications, 'save')

    saveSpy.mockRejectedValueOnce(new Error('mongo unavailable'))

    const first = await post(retryPayload)

    expect(first.status).toBe(503)

    const retry = await post(retryPayload)

    expect(retry.status).toBe(201)

    const pending = await notifications.findPendingForPlayer(retryPayload.recipientPlayerId)

    expect(pending.some((notification) => notification.id === retryPayload.notificationId)).toBe(
      true,
    )

    saveSpy.mockRestore()
  })

  it('no expone el contrato en otras rutas o metodos', async () => {
    expect((await fetch(url + '/wrong')).status).toBe(404)

    expect((await fetch(url + AUCTION_OUTBID_PATH)).status).toBe(405)
  })
})
