import { describe, expect, it } from '@jest/globals'
import { parseAuctionSettledEventV1 } from '../../../src/adapters/messaging/AuctionSettledEventParser.js'

const body = JSON.stringify({
  eventId: 'evt',
  eventType: 'auction.settled',
  eventVersion: 1,
  aggregateId: 'auction',
  occurredAt: '2026-01-01T00:00:00.000Z',
  producer: 'auction',
  correlationId: 'corr',
  data: {
    auctionId: 'auction',
    productId: 'product',
    sellerId: 'seller',
    resultType: 'WITHOUT_BIDS',
    settledAt: '2026-01-01T00:00:00.000Z',
  },
})
describe('AuctionSettledEventParser', () => {
  it('acepta V1 y rechaza JSON, productor o version invalidos', () => {
    expect(parseAuctionSettledEventV1(body).data.resultType).toBe('WITHOUT_BIDS')
    expect(() => parseAuctionSettledEventV1('{')).toThrow()
    expect(() =>
      parseAuctionSettledEventV1(body.replace('"eventVersion":1', '"eventVersion":2')),
    ).toThrow()
  })
})
