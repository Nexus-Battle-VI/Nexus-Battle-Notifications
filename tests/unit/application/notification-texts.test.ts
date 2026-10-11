import { describe, expect, it } from '@jest/globals'

import { InMemoryCatalogNotificationRepository } from '../../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import type {
  AuctionBidAcceptedEventV1,
  AuctionPublishedEventV1,
} from '../../../src/application/dto/AuctionConfirmationEvent.js'
import type { AuctionSettledEventV1 } from '../../../src/application/dto/AuctionSettledEventV1.js'
import { parseBattleDropNotification } from '../../../src/application/dto/BattleDropNotification.js'
import { CreateBattleDropNotification } from '../../../src/application/use-cases/CreateBattleDropNotification.js'
import { HandleAuctionConfirmationEvent } from '../../../src/application/use-cases/HandleAuctionConfirmationEvent.js'
import { HandleAuctionSettledEvent } from '../../../src/application/use-cases/HandleAuctionSettledEvent.js'
import {
  formatCredits,
  formatNotificationDate,
} from '../../../src/application/use-cases/notification-text.js'

/**
 * EN-031: lo que lee el jugador no expone identificadores internos (subasta,
 * puja, producto, jugador, objeto). Cada prueba usa identificadores
 * reconocibles y comprueba que NINGUNO aparece en el texto: si alguien vuelve
 * a interpolar uno, falla. Los identificadores siguen en `id`,
 * `sourceEventId` y `productId`.
 */
const IDS = [
  'auction-7f3a',
  'product-9c1e',
  'seller-55',
  'bidder-66',
  'winner-77',
  'loser-88',
  'bid-4d2b',
  'sword-1f0a',
]

const expectNoIds = (text: string | undefined): void => {
  expect(text).toBeDefined()
  for (const id of IDS) expect(text).not.toContain(id)
}

const clock = { now: (): Date => new Date('2026-10-11T12:00:00.000Z') }

describe('textos de notificacion sin identificadores (EN-031)', () => {
  it('formatea creditos y fechas en espanol de Colombia', () => {
    expect(formatCredits(1500)).toBe('1.500 créditos')
    expect(formatNotificationDate('2026-10-04T20:00:00.000Z')).toContain('4 de octubre de 2026')
    expect(formatNotificationDate('no-es-fecha')).toBeNull()
  })

  it('subasta finalizada: vendedor, ganador y perdedor', async () => {
    const notifications = new InMemoryCatalogNotificationRepository()
    const event: AuctionSettledEventV1 = {
      eventId: 'event-1',
      eventType: 'auction.settled',
      eventVersion: 1,
      aggregateId: 'auction-7f3a',
      occurredAt: '2026-10-11T00:00:00.000Z',
      producer: 'auction',
      correlationId: 'correlation-1',
      data: {
        auctionId: 'auction-7f3a',
        productId: 'product-9c1e',
        sellerId: 'seller-55',
        resultType: 'WITH_WINNER',
        winnerId: 'winner-77',
        winningBidId: 'bid-4d2b',
        finalAmountCredits: 1500,
        loserBidderIds: ['loser-88'],
        settledAt: '2026-10-11T00:00:00.000Z',
      },
    }
    await new HandleAuctionSettledEvent({ notifications, clock }).execute(event)

    const seller = (await notifications.findHistoryForPlayer('seller-55'))[0]
    const winner = (await notifications.findHistoryForPlayer('winner-77'))[0]
    const loser = (await notifications.findHistoryForPlayer('loser-88'))[0]

    expect(seller?.description).toBe('Tu subasta finalizó con una venta por 1.500 créditos.')
    expect(winner?.description).toBe('Ganaste una subasta por 1.500 créditos.')
    expect(loser?.description).toBe('No ganaste una subasta en la que pujaste.')
    for (const notification of [seller, winner, loser]) expectNoIds(notification?.description)
    // El identificador de la subasta sigue en el estructurado.
    expect(winner?.id).toBe('auction:auction-7f3a:settled:winner:winner-77')
  })

  it('publicacion y pujas confirmadas', async () => {
    const repository = new InMemoryCatalogNotificationRepository()
    const handler = new HandleAuctionConfirmationEvent(repository, clock)
    const published: AuctionPublishedEventV1 = {
      eventId: 'publication-1',
      eventType: 'auction.published',
      eventVersion: 1,
      aggregateId: 'auction-7f3a',
      occurredAt: '2026-10-03T20:00:00.000Z',
      producer: 'auction',
      correlationId: 'op-1',
      data: {
        auctionId: 'auction-7f3a',
        sellerId: 'seller-55',
        productId: 'product-9c1e',
        publishedAt: '2026-10-03T20:00:00.000Z',
        closesAt: '2026-10-04T20:00:00.000Z',
      },
    }
    const accepted: AuctionBidAcceptedEventV1 = {
      eventId: 'bid-op-1:bid-accepted',
      eventType: 'auction.bid.accepted',
      eventVersion: 1,
      aggregateId: 'auction-7f3a',
      occurredAt: '2026-10-03T21:00:00.000Z',
      producer: 'auction',
      correlationId: 'bid-op-1',
      data: {
        operationId: 'bid-op-1',
        auctionId: 'auction-7f3a',
        sellerId: 'seller-55',
        productId: 'product-9c1e',
        bidderId: 'bidder-66',
        bidId: 'bid-4d2b',
        amountCredits: 250,
        acceptedAt: '2026-10-03T21:00:00.000Z',
      },
    }
    await handler.execute(published)
    await handler.execute(accepted)

    const seller = await repository.findHistoryForPlayer('seller-55')
    const bidder = await repository.findHistoryForPlayer('bidder-66')
    const publication = seller.find((n) => n.changeType === 'AUCTION_PUBLISHED')
    const newBid = seller.find((n) => n.changeType === 'AUCTION_NEW_BID')

    expect(publication?.description).toMatch(
      /^Publicaste una subasta\. Finaliza el 4 de octubre de 2026/u,
    )
    expect(publication?.description).not.toContain('2026-10-04T20:00:00.000Z')
    expect(newBid?.description).toBe('Tu subasta recibió una puja de 250 créditos.')
    expect(bidder[0]?.description).toBe('Tu puja de 250 créditos fue aceptada.')
    for (const notification of [publication, newBid, bidder[0]])
      expectNoIds(notification?.description)
    expect(publication?.productId).toBe('product-9c1e')
  })

  it('botin de Versus: gana o pierde un objeto sin mostrar su identificador', async () => {
    const repository = new InMemoryCatalogNotificationRepository()
    const useCase = new CreateBattleDropNotification(repository, clock)
    const command = {
      battleId: 'battle-1',
      defeatEventSeq: 1,
      role: 'GAINED' as const,
      recipientId: 'winner-77',
      productInstanceId: 'unit-1',
      productId: 'product-9c1e',
      itemId: 'sword-1f0a',
      creditedAt: '2026-10-11T12:00:00.000Z',
    }
    await useCase.execute(parseBattleDropNotification(command))
    await useCase.execute(
      parseBattleDropNotification({ ...command, role: 'LOST', recipientId: 'loser-88' }),
    )

    const gained = (await repository.findHistoryForPlayer('winner-77'))[0]
    const lost = (await repository.findHistoryForPlayer('loser-88'))[0]

    expect(gained?.description).toBe('Obtuviste un objeto del rival derrotado en Versus.')
    expect(lost?.description).toBe('Perdiste un objeto al ser derrotado en Versus.')
    expectNoIds(gained?.description)
    expectNoIds(lost?.description)
    expect(gained?.productId).toBe('product-9c1e')
  })
})
