import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { InMemoryIdempotencyStore } from '../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { signInternalRequest } from '../../src/adapters/identity/internal-signature.js'
import { InMemoryCatalogNotificationRepository } from '../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { SystemClock } from '../../src/adapters/clock/SystemClock.js'
import { CreateAuctionClosedByBuyNowNotification } from '../../src/application/use-cases/CreateAuctionClosedByBuyNowNotification.js'
import { CreateAuctionOutbidNotification } from '../../src/application/use-cases/CreateAuctionOutbidNotification.js'
import { CreateAuctionAutoBidLimitReachedNotification } from '../../src/application/use-cases/CreateAuctionAutoBidLimitReachedNotification.js'
import { CatalogChangeType } from '../../src/domain/entities/CatalogChangeType.js'
import {
  AUCTION_AUTO_BID_LIMIT_REACHED_PATH,
  AUCTION_CLOSED_BY_BUY_NOW_PATH,
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

const buyNowPayload = {
  operationId: 'op-buy-now-1',
  auctionId: 'auction-1',
  recipientId: 'player-1',
  transactionId: 'tx-1',
  closedAt: '2026-09-24T14:00:00.000Z',
}

describe('HTTP interno - subasta cerrada por compra inmediata', () => {
  let server: Server
  let url: string
  let notifications: InMemoryCatalogNotificationRepository
  const logger = createLogger({
    level: 'error',
    service: 'test',
    version: 'test',
  })

  beforeAll(async () => {
    notifications = new InMemoryCatalogNotificationRepository()

    const clock = new SystemClock()

    const idempotencyStore = new InMemoryIdempotencyStore(() => clock.now().getTime())

    const dependencies = {
      notifications,
      idempotencyStore,
      clock,
      idempotencyTtlMs: 86_400_000,
    }

    server = createAuctionOutbidServer({
      port: 0,
      sharedSecret: secret,
      useCase: new CreateAuctionOutbidNotification(dependencies),
      closedByBuyNowUseCase: new CreateAuctionClosedByBuyNowNotification(dependencies),
      logger,
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
    body: unknown = buyNowPayload,
    options: {
      readonly path?: string
      readonly service?: string
      readonly timestamp?: string
      readonly signature?: string
    } = {},
  ): Promise<Response> => {
    const path = options.path ?? AUCTION_CLOSED_BY_BUY_NOW_PATH
    const service = options.service ?? 'auction'
    const timestamp = options.timestamp ?? String(Date.now())
    const signature =
      options.signature ??
      signInternalRequest(secret, {
        service,
        method: 'POST',
        path,
        timestamp,
        body,
      })

    return fetch(url + path, {
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

  it('A. caller auction con HMAC valido crea la notificacion (201)', async () => {
    const response = await post()

    expect(response.status).toBe(201)

    expect(await response.json()).toEqual({
      notificationId: buyNowPayload.operationId,
      status: 'created',
    })

    const stored = await notifications.findById(buyNowPayload.operationId)

    expect(stored?.changeType).toBe(CatalogChangeType.AuctionClosedByBuyNow)

    expect(stored?.playerId).toBe(buyNowPayload.recipientId)
  })

  it('B. mismo operationId y mismo payload responde duplicated (200)', async () => {
    const response = await post()

    expect(response.status).toBe(200)

    expect(await response.json()).toEqual({
      notificationId: buyNowPayload.operationId,
      status: 'duplicated',
    })

    expect(await notifications.findHistoryForPlayer(buyNowPayload.recipientId)).toHaveLength(1)
  })

  it('C. mismo operationId con payload diferente responde 409', async () => {
    const response = await post({ ...buyNowPayload, auctionId: 'auction-other' })

    expect(response.status).toBe(409)

    expect(await response.json()).toEqual({ error: 'operation_conflict' })
  })

  it('409 real: segundo request firmado con su propio body entra en conflicto y persiste una sola', async () => {
    const first = {
      operationId: 'op-conflict',
      auctionId: 'auction-1',
      recipientId: 'player-conflict',
      transactionId: 'tx-1',
      closedAt: '2026-09-24T15:00:00.000Z',
    }

    const second = { ...first, auctionId: 'auction-2' }

    expect((await post(first)).status).toBe(201)

    // post() recalcula el HMAC con el body del segundo request.
    expect((await post(second)).status).toBe(409)

    const stored = await notifications.findHistoryForPlayer(first.recipientId)

    expect(stored).toHaveLength(1)

    expect(stored[0]?.id).toBe('op-conflict')

    expect(stored[0]?.description).toContain('auction-1')

    expect(stored[0]?.description).not.toContain('auction-2')
  })

  it('D. rechaza request sin firma', async () => {
    const response = await fetch(url + AUCTION_CLOSED_BY_BUY_NOW_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service': 'auction',
        'x-internal-timestamp': String(Date.now()),
      },
      body: JSON.stringify(buyNowPayload),
    })

    expect(response.status).toBe(401)
  })

  it('E. rechaza firma incorrecta, incluida la firmada con el path de outbid', async () => {
    expect((await post(buyNowPayload, { signature: 'a'.repeat(64) })).status).toBe(401)

    const timestamp = String(Date.now())

    const outbidPathSignature = signInternalRequest(secret, {
      service: 'auction',
      method: 'POST',
      path: AUCTION_OUTBID_PATH,
      timestamp,
      body: buyNowPayload,
    })

    expect((await post(buyNowPayload, { timestamp, signature: outbidPathSignature })).status).toBe(
      401,
    )
  })

  it('F. rechaza x-internal-service distinto de auction', async () => {
    expect((await post(buyNowPayload, { service: 'commerce' })).status).toBe(401)
  })

  it('G. rechaza timestamp invalido o expirado', async () => {
    expect((await post(buyNowPayload, { timestamp: '0' })).status).toBe(401)

    expect((await post(buyNowPayload, { timestamp: 'not-a-timestamp' })).status).toBe(401)

    expect(
      (await post(buyNowPayload, { timestamp: String(Date.now() - 24 * 60 * 60 * 1000) })).status,
    ).toBe(401)
  })

  it('H. rechaza payload incompleto', async () => {
    const incomplete = {
      operationId: 'op-h',
      auctionId: buyNowPayload.auctionId,
      recipientId: buyNowPayload.recipientId,
      closedAt: buyNowPayload.closedAt,
    }

    expect((await post(incomplete)).status).toBe(400)
  })

  it('I. rechaza closedAt invalido', async () => {
    expect(
      (await post({ ...buyNowPayload, operationId: 'op-i', closedAt: 'not-a-date' })).status,
    ).toBe(400)
  })

  it('J. rechaza operationId vacio', async () => {
    expect((await post({ ...buyNowPayload, operationId: '' })).status).toBe(400)

    expect((await post({ ...buyNowPayload, operationId: '   ' })).status).toBe(400)
  })

  it('usa codigo de error y eventos de log propios de closed-by-buy-now', async () => {
    const warn = jest.spyOn(logger, 'warn')
    const info = jest.spyOn(logger, 'info')

    const invalid = await post({ ...buyNowPayload, operationId: 'op-log', closedAt: 'x' })

    expect(invalid.status).toBe(400)

    expect(await invalid.json()).toMatchObject({
      error: 'invalid_auction_closed_by_buy_now_notification',
    })

    expect((await post(buyNowPayload, { service: 'commerce' })).status).toBe(401)

    expect(warn).toHaveBeenCalledWith('auction_closed_by_buy_now_unauthorized', {})

    expect(warn).not.toHaveBeenCalledWith('auction_outbid_unauthorized', expect.anything())

    expect(
      (await post({ ...buyNowPayload, operationId: 'op-log', closedAt: buyNowPayload.closedAt }))
        .status,
    ).toBe(201)

    expect(info).toHaveBeenCalledWith(
      'auction_closed_by_buy_now_notification_accepted',
      expect.objectContaining({
        notificationId: 'op-log',
        outcome: 'created',
        auctionId: buyNowPayload.auctionId,
        transactionId: buyNowPayload.transactionId,
      }),
    )

    warn.mockRestore()
    info.mockRestore()
  })

  it('los rechazos no persisten notificaciones adicionales', async () => {
    for (const id of ['op-h', 'op-i', '', '   ']) {
      expect(await notifications.findById(id)).toBeNull()
    }
  })

  it('regresion: outbid sigue funcionando en el mismo servidor', async () => {
    const response = await post(
      { ...payload, notificationId: 'op-regression:outbid', operationId: 'op-regression' },
      { path: AUCTION_OUTBID_PATH },
    )

    expect(response.status).toBe(201)

    expect(await response.json()).toEqual({
      notificationId: 'op-regression:outbid',
      status: 'created',
    })
  })
})

const autoBidLimitPayload = {
  notificationId: 'operation-67-1:auto-bid-limit-reached',
  operationId: 'operation-67-1',
  recipientPlayerId: 'player-auto-bidder',
  auctionId: 'auction-67-1',
  autoBidLimitCredits: 500,
  requiredAmountCredits: 550,
  leadingBidderId: 'player-new-leader',
  occurredAt: '2026-09-24T18:00:00.000Z',
}

describe('HTTP interno - limite de puja automatica alcanzado (HU-67)', () => {
  let server: Server
  let url: string
  let notifications: InMemoryCatalogNotificationRepository
  const logger = createLogger({
    level: 'error',
    service: 'test',
    version: 'test',
  })

  beforeAll(async () => {
    notifications = new InMemoryCatalogNotificationRepository()

    const clock = new SystemClock()

    const idempotencyStore = new InMemoryIdempotencyStore(() => clock.now().getTime())

    const dependencies = {
      notifications,
      idempotencyStore,
      clock,
      idempotencyTtlMs: 86_400_000,
    }

    server = createAuctionOutbidServer({
      port: 0,
      sharedSecret: secret,
      useCase: new CreateAuctionOutbidNotification(dependencies),
      autoBidLimitReachedUseCase: new CreateAuctionAutoBidLimitReachedNotification(dependencies),
      logger,
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
    body: unknown = autoBidLimitPayload,
    options: {
      readonly path?: string
      readonly service?: string
      readonly timestamp?: string
      readonly signature?: string
    } = {},
  ): Promise<Response> => {
    const path = options.path ?? AUCTION_AUTO_BID_LIMIT_REACHED_PATH
    const service = options.service ?? 'auction'
    const timestamp = options.timestamp ?? String(Date.now())
    const signature =
      options.signature ??
      signInternalRequest(secret, {
        service,
        method: 'POST',
        path,
        timestamp,
        body,
      })

    return fetch(url + path, {
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

  it('A. caller auction con HMAC valido crea la notificacion (201)', async () => {
    const response = await post()

    expect(response.status).toBe(201)

    expect(await response.json()).toEqual({
      notificationId: autoBidLimitPayload.notificationId,
      status: 'created',
    })

    const stored = await notifications.findById(autoBidLimitPayload.notificationId)

    expect(stored?.changeType).toBe(CatalogChangeType.AuctionAutoBidLimitReached)

    expect(stored?.playerId).toBe(autoBidLimitPayload.recipientPlayerId)

    expect(stored?.description).toContain(autoBidLimitPayload.auctionId)

    expect(stored?.description).toContain(String(autoBidLimitPayload.autoBidLimitCredits))

    expect(stored?.sourceEventType).toBe('auction.auto-bid.limit-reached.v1')
  })

  it('B. un replay no crea una segunda notificacion', async () => {
    const response = await post()

    expect(response.status).toBe(200)

    expect(await response.json()).toEqual({
      notificationId: autoBidLimitPayload.notificationId,
      status: 'duplicated',
    })

    expect(
      await notifications.findHistoryForPlayer(autoBidLimitPayload.recipientPlayerId),
    ).toHaveLength(1)
  })

  it('C. rechaza payload invalido', async () => {
    expect((await post({ ...autoBidLimitPayload, autoBidLimitCredits: 0 })).status).toBe(400)

    expect((await post({ ...autoBidLimitPayload, requiredAmountCredits: -1 })).status).toBe(400)
  })

  it('D. rechaza request sin firma', async () => {
    const response = await fetch(url + AUCTION_AUTO_BID_LIMIT_REACHED_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service': 'auction',
        'x-internal-timestamp': String(Date.now()),
      },
      body: JSON.stringify(autoBidLimitPayload),
    })

    expect(response.status).toBe(401)
  })

  it('E. rechaza firma incorrecta, incluida la firmada con el path de outbid', async () => {
    expect((await post(autoBidLimitPayload, { signature: 'a'.repeat(64) })).status).toBe(401)

    const timestamp = String(Date.now())

    const outbidPathSignature = signInternalRequest(secret, {
      service: 'auction',
      method: 'POST',
      path: AUCTION_OUTBID_PATH,
      timestamp,
      body: autoBidLimitPayload,
    })

    expect(
      (await post(autoBidLimitPayload, { timestamp, signature: outbidPathSignature })).status,
    ).toBe(401)
  })

  it('F. rechaza x-internal-service distinto de auction', async () => {
    expect((await post(autoBidLimitPayload, { service: 'commerce' })).status).toBe(401)
  })

  it('G. rechaza timestamp invalido o expirado', async () => {
    expect((await post(autoBidLimitPayload, { timestamp: '0' })).status).toBe(401)

    expect((await post(autoBidLimitPayload, { timestamp: 'not-a-timestamp' })).status).toBe(401)

    expect(
      (
        await post(autoBidLimitPayload, {
          timestamp: String(Date.now() - 24 * 60 * 60 * 1000),
        })
      ).status,
    ).toBe(401)
  })

  it('H. rechaza payload incompleto', async () => {
    const incomplete = {
      notificationId: 'op-h:auto-bid-limit-reached',
      operationId: 'op-h',
      recipientPlayerId: autoBidLimitPayload.recipientPlayerId,
      auctionId: autoBidLimitPayload.auctionId,
    }

    expect((await post(incomplete)).status).toBe(400)
  })

  it('I. rechaza occurredAt invalido', async () => {
    expect(
      (
        await post({
          ...autoBidLimitPayload,
          notificationId: 'op-i:auto-bid-limit-reached',
          operationId: 'op-i',
          occurredAt: 'not-a-date',
        })
      ).status,
    ).toBe(400)
  })

  it('J. rechaza que el destinatario sea el mismo postor lider', async () => {
    expect(
      (
        await post({
          ...autoBidLimitPayload,
          notificationId: 'op-j:auto-bid-limit-reached',
          operationId: 'op-j',
          leadingBidderId: autoBidLimitPayload.recipientPlayerId,
        })
      ).status,
    ).toBe(400)
  })

  it('usa codigo de error y eventos de log propios de auto-bid-limit-reached', async () => {
    const warn = jest.spyOn(logger, 'warn')
    const info = jest.spyOn(logger, 'info')

    const invalid = await post({
      ...autoBidLimitPayload,
      notificationId: 'op-log:auto-bid-limit-reached',
      operationId: 'op-log',
      occurredAt: 'x',
    })

    expect(invalid.status).toBe(400)

    expect(await invalid.json()).toMatchObject({
      error: 'invalid_auto_bid_limit_reached_notification',
    })

    expect((await post(autoBidLimitPayload, { service: 'commerce' })).status).toBe(401)

    expect(warn).toHaveBeenCalledWith('auction_auto_bid_limit_reached_unauthorized', {})

    expect(warn).not.toHaveBeenCalledWith('auction_outbid_unauthorized', expect.anything())

    expect(
      (
        await post({
          ...autoBidLimitPayload,
          notificationId: 'op-log:auto-bid-limit-reached',
          operationId: 'op-log',
        })
      ).status,
    ).toBe(201)

    expect(info).toHaveBeenCalledWith(
      'auction_auto_bid_limit_reached_notification_accepted',
      expect.objectContaining({
        notificationId: 'op-log:auto-bid-limit-reached',
        outcome: 'created',
        auctionId: autoBidLimitPayload.auctionId,
        recipientPlayerId: autoBidLimitPayload.recipientPlayerId,
      }),
    )

    warn.mockRestore()
    info.mockRestore()
  })

  it('un fallo temporal responde 503 y permite un reintento posterior', async () => {
    const retryPayload = {
      ...autoBidLimitPayload,
      notificationId: 'operation-retry:auto-bid-limit-reached',
      operationId: 'operation-retry',
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

  it('regresion: outbid sigue funcionando en el mismo servidor', async () => {
    const response = await post(
      { ...payload, notificationId: 'op-regression-2:outbid', operationId: 'op-regression-2' },
      { path: AUCTION_OUTBID_PATH },
    )

    expect(response.status).toBe(201)

    expect(await response.json()).toEqual({
      notificationId: 'op-regression-2:outbid',
      status: 'created',
    })
  })
})
