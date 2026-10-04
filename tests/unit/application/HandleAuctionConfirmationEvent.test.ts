import { describe, expect, jest, test } from '@jest/globals'
import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { HandleAuctionConfirmationEvent } from '../../../src/application/use-cases/HandleAuctionConfirmationEvent.js'
import {
  parseAuctionConfirmationEvent,
  type AuctionBidAcceptedEventV1,
  type AuctionBuyNowCompletedEventV1,
  type AuctionProductClaimedEventV1,
  type AuctionPublishedEventV1,
} from '../../../src/application/dto/AuctionConfirmationEvent.js'

const occurredAt = '2026-10-03T20:00:00.000Z'
const clock = { now: (): Date => new Date('2026-10-03T20:01:00.000Z') }
const published: AuctionPublishedEventV1 = {
  eventId: 'publication-event-1',
  eventType: 'auction.published',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt,
  producer: 'auction',
  correlationId: 'publication-op-1',
  data: {
    auctionId: 'auction-1',
    sellerId: 'seller-1',
    productId: 'product-1',
    publishedAt: occurredAt,
    closesAt: '2026-10-04T20:00:00.000Z',
  },
}
const accepted: AuctionBidAcceptedEventV1 = {
  eventId: 'bid-op-1:bid-accepted',
  eventType: 'auction.bid.accepted',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt,
  producer: 'auction',
  correlationId: 'bid-op-1',
  data: {
    operationId: 'bid-op-1',
    auctionId: 'auction-1',
    sellerId: 'seller-1',
    productId: 'product-1',
    bidderId: 'bidder-1',
    bidId: 'bid-1',
    amountCredits: 100,
    acceptedAt: occurredAt,
  },
}
const buyNow: AuctionBuyNowCompletedEventV1 = {
  eventId: 'buy-now-op-1:buy-now-completed',
  eventType: 'auction.buy-now.completed',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt,
  producer: 'auction',
  correlationId: 'buy-now-op-1',
  data: {
    operationId: 'buy-now-op-1',
    transactionId: 'transaction-1',
    transferId: 'transfer-1',
    auctionId: 'auction-1',
    productId: 'product-1',
    sellerId: 'seller-1',
    buyerId: 'buyer-1',
    amountCredits: 100,
    completedAt: occurredAt,
  },
}
const claimed: AuctionProductClaimedEventV1 = {
  eventId: 'auction:auction-1:product-claimed',
  eventType: 'auction.product.claimed',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt,
  producer: 'auction',
  correlationId: 'auction:auction-1:inventory:claim',
  data: {
    auctionId: 'auction-1',
    winnerId: 'winner-1',
    productId: 'product-1',
    claimedAt: occurredAt,
  },
}

describe('HandleAuctionConfirmationEvent HU-92.2', () => {
  test('publicacion: avisa solo al vendedor y conserva la identidad al reintentar', async () => {
    const repo = new InMemoryCatalogNotificationRepository()
    const handler = new HandleAuctionConfirmationEvent(repo, clock)
    await expect(handler.execute(published)).resolves.toEqual({
      eventId: published.eventId,
      created: 1,
      duplicated: 0,
    })
    const first = await repo.findHistoryForPlayer('seller-1')
    expect(first).toHaveLength(1)
    expect(first[0]?.changeType).toBe('AUCTION_PUBLISHED')
    expect(await repo.findAllGlobal()).toHaveLength(0)
    await expect(
      new HandleAuctionConfirmationEvent(repo, clock).execute(published),
    ).resolves.toEqual({ eventId: published.eventId, created: 0, duplicated: 1 })
    expect((await repo.findHistoryForPlayer('seller-1'))[0]?.id).toBe(first[0]?.id)
  })

  test('puja: avisa a vendedor y postor sin exponer avisos a otro jugador', async () => {
    const repo = new InMemoryCatalogNotificationRepository()
    await new HandleAuctionConfirmationEvent(repo, clock).execute(accepted)
    expect((await repo.findHistoryForPlayer('seller-1'))[0]?.changeType).toBe('AUCTION_NEW_BID')
    expect((await repo.findHistoryForPlayer('bidder-1'))[0]?.changeType).toBe(
      'AUCTION_BID_ACCEPTED',
    )
    expect(await repo.findHistoryForPlayer('outsider')).toHaveLength(0)
    expect(await repo.findAllGlobal()).toHaveLength(0)
  })

  test('buy-now acredita al vendedor y confirma solo al comprador', async () => {
    const repo = new InMemoryCatalogNotificationRepository()
    const handler = new HandleAuctionConfirmationEvent(repo, clock)
    await expect(handler.execute(buyNow)).resolves.toEqual({
      eventId: buyNow.eventId,
      created: 2,
      duplicated: 0,
    })
    expect((await repo.findHistoryForPlayer('seller-1'))[0]).toMatchObject({
      changeType: 'AUCTION_SELLER_CREDITED',
      description: expect.stringContaining('transfer-1'),
    })
    expect((await repo.findHistoryForPlayer('buyer-1'))[0]?.changeType).toBe(
      'AUCTION_BUY_NOW_COMPLETED',
    )
    expect(await repo.findHistoryForPlayer('outsider')).toHaveLength(0)
  })

  test('reclamo: confirma una sola vez al ganador', async () => {
    const repo = new InMemoryCatalogNotificationRepository()
    const handler = new HandleAuctionConfirmationEvent(repo, clock)
    await expect(handler.execute(claimed)).resolves.toEqual({
      eventId: claimed.eventId,
      created: 1,
      duplicated: 0,
    })
    await expect(handler.execute(claimed)).resolves.toEqual({
      eventId: claimed.eventId,
      created: 0,
      duplicated: 1,
    })
    expect((await repo.findHistoryForPlayer('winner-1'))[0]?.changeType).toBe(
      'AUCTION_PRODUCT_CLAIMED',
    )
  })

  test('un replay conserva el estado leido y no vuelve a guardar', async () => {
    const repo = new InMemoryCatalogNotificationRepository()
    const handler = new HandleAuctionConfirmationEvent(repo, clock)
    await handler.execute(accepted)
    const notification = (await repo.findHistoryForPlayer('bidder-1'))[0]
    if (notification === undefined) throw new Error('Notificacion faltante')
    notification.markRead(clock.now())
    await repo.updateReadStatus(notification)
    const save = jest.spyOn(repo, 'save')
    await expect(handler.execute(accepted)).resolves.toEqual({
      eventId: accepted.eventId,
      created: 0,
      duplicated: 2,
    })
    expect(save).not.toHaveBeenCalled()
    expect(notification.readStatus).toBe('READ')
  })

  test('recupera un guardado parcial sin duplicar el aviso del vendedor', async () => {
    const repo = new InMemoryCatalogNotificationRepository()
    const handler = new HandleAuctionConfirmationEvent(repo, clock)
    const realSave = repo.save.bind(repo)
    const save = jest.spyOn(repo, 'save').mockImplementation(async (notification) => {
      if (notification.playerId === 'bidder-1') throw new Error('mongo unavailable')
      await realSave(notification)
    })
    await expect(handler.execute(accepted)).rejects.toThrow('mongo unavailable')
    expect(await repo.findHistoryForPlayer('seller-1')).toHaveLength(1)
    save.mockRestore()
    await expect(handler.execute(accepted)).resolves.toEqual({
      eventId: accepted.eventId,
      created: 1,
      duplicated: 1,
    })
  })

  test('rechaza reutilizar el evento con otro importe antes de modificar avisos', async () => {
    const repo = new InMemoryCatalogNotificationRepository()
    const handler = new HandleAuctionConfirmationEvent(repo, clock)
    await handler.execute(accepted)
    const save = jest.spyOn(repo, 'save')
    await expect(
      handler.execute({ ...accepted, data: { ...accepted.data, amountCredits: 200 } }),
    ).rejects.toThrow('operation_conflict')
    expect(save).not.toHaveBeenCalled()
  })

  test('un contrato invalido no genera notificaciones', async () => {
    const repo = new InMemoryCatalogNotificationRepository()
    await expect(
      new HandleAuctionConfirmationEvent(repo, clock).execute({
        ...accepted,
        data: { ...accepted.data, bidderId: accepted.data.sellerId },
      }),
    ).rejects.toThrow('inconsistentes')
    expect(await repo.findHistoryForPlayer('seller-1')).toHaveLength(0)
    expect(() => parseAuctionConfirmationEvent({ ...published, producer: 'combat' })).toThrow(
      'no soportados',
    )
    expect(() => parseAuctionConfirmationEvent({ ...accepted, eventId: 'wrong' })).toThrow(
      'inconsistentes',
    )
  })
})
