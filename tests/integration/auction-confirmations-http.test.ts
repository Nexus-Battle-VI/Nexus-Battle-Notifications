import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SystemClock } from '../../src/adapters/clock/SystemClock.js'
import { InMemoryIdempotencyStore } from '../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { signInternalRequest } from '../../src/adapters/identity/internal-signature.js'
import { InMemoryCatalogNotificationRepository } from '../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { CreateAuctionOutbidNotification } from '../../src/application/use-cases/CreateAuctionOutbidNotification.js'
import { HandleAuctionConfirmationEvent } from '../../src/application/use-cases/HandleAuctionConfirmationEvent.js'
import {
  AUCTION_CONFIRMATIONS_PATH,
  createAuctionOutbidServer,
} from '../../src/infrastructure/http/auction-outbid-server.js'
import { createLogger } from '../../src/infrastructure/observability/logger.js'

const secret = 'auction-confirmations-test-secret'

const published = {
  eventId: 'publication-op-1:published',
  eventType: 'auction.published',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt: '2026-10-03T20:00:00.000Z',
  producer: 'auction',
  correlationId: 'publication-op-1',
  data: {
    auctionId: 'auction-1',
    sellerId: 'seller-1',
    productId: 'product-1',
    publishedAt: '2026-10-03T20:00:00.000Z',
    closesAt: '2026-10-04T20:00:00.000Z',
  },
} as const

const accepted = {
  eventId: 'bid-op-1:bid-accepted',
  eventType: 'auction.bid.accepted',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt: '2026-10-03T20:00:00.000Z',
  producer: 'auction',
  correlationId: 'bid-op-1',
  data: {
    operationId: 'bid-op-1',
    auctionId: 'auction-1',
    productId: 'product-1',
    sellerId: 'seller-1',
    bidderId: 'bidder-1',
    bidId: 'bid-1',
    amountCredits: 100,
    acceptedAt: '2026-10-03T20:00:00.000Z',
  },
} as const

describe('HTTP interno HU-92.2 - confirmaciones de Auction', () => {
  let server: Server
  let url: string
  let notifications: InMemoryCatalogNotificationRepository

  beforeAll(async () => {
    notifications = new InMemoryCatalogNotificationRepository()
    const clock = new SystemClock()
    server = createAuctionOutbidServer({
      port: 0,
      sharedSecret: secret,
      useCase: new CreateAuctionOutbidNotification({
        notifications,
        idempotencyStore: new InMemoryIdempotencyStore(() => clock.now().getTime()),
        clock,
        idempotencyTtlMs: 86_400_000,
      }),
      confirmationUseCase: new HandleAuctionConfirmationEvent(notifications, clock),
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

  const post = (body: unknown, signature = true): Promise<Response> => {
    const timestamp = String(Date.now())
    return fetch(url + AUCTION_CONFIRMATIONS_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service': 'auction',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': signature
          ? signInternalRequest(secret, {
              service: 'auction',
              method: 'POST',
              path: AUCTION_CONFIRMATIONS_PATH,
              timestamp,
              body,
            })
          : 'invalid',
      },
      body: JSON.stringify(body),
    })
  }

  it('confirma una publicacion solo al vendedor y conserva el replay', async () => {
    const first = await post(published)
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ eventId: published.eventId, created: 1, duplicated: 0 })
    expect((await notifications.findHistoryForPlayer('seller-1'))[0]?.changeType).toBe(
      'AUCTION_PUBLISHED',
    )
    expect(await notifications.findHistoryForPlayer('outsider')).toHaveLength(0)
    expect(await notifications.findAllGlobal()).toHaveLength(0)

    const replay = await post(published)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ eventId: published.eventId, created: 0, duplicated: 1 })
  })

  it('avisa al vendedor y confirma al postor sin exponer avisos a terceros', async () => {
    const response = await post(accepted)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ eventId: accepted.eventId, created: 2, duplicated: 0 })
    expect(
      (await notifications.findHistoryForPlayer('seller-1')).some(
        (notification) => notification.changeType === 'AUCTION_NEW_BID',
      ),
    ).toBe(true)
    expect((await notifications.findHistoryForPlayer('bidder-1'))[0]?.changeType).toBe(
      'AUCTION_BID_ACCEPTED',
    )
    expect(await notifications.findHistoryForPlayer('outsider')).toHaveLength(0)
  })

  it('rechaza contratos invalidos y firmas invalidas sin crear avisos', async () => {
    const before = await notifications.findHistoryForPlayer('seller-1')
    const invalid = {
      ...accepted,
      eventId: 'bid-op-invalid:bid-accepted',
      correlationId: 'bid-op-invalid',
      data: { ...accepted.data, operationId: 'bid-op-invalid', bidderId: 'seller-1' },
    }
    expect((await post(invalid)).status).toBe(400)
    expect((await post({ ...published, eventId: 'unauthorized-publication' }, false)).status).toBe(
      401,
    )
    expect(await notifications.findHistoryForPlayer('seller-1')).toHaveLength(before.length)
  })
})
