import { InMemoryCatalogNotificationRepository } from '../../src/adapters/persistence/InMemoryCatalogNotificationRepository.js'
import { parseBattleDropNotification } from '../../src/application/dto/BattleDropNotification.js'
import { CreateBattleDropNotification } from '../../src/application/use-cases/CreateBattleDropNotification.js'
import { CatalogChangeType } from '../../src/domain/entities/CatalogChangeType.js'

const command = {
  battleId: 'battle-1',
  defeatEventSeq: 2,
  role: 'GAINED' as const,
  recipientId: 'winner',
  productInstanceId: 'unit-1',
  productId: 'product-1',
  itemId: 'sword-1',
  creditedAt: '2026-10-01T12:00:00.000Z',
}

describe('HU-30: notificaciones de transferencia confirmada', () => {
  it('genera una por destinatario y repite idempotentemente', async () => {
    const repository = new InMemoryCatalogNotificationRepository()
    const useCase = new CreateBattleDropNotification(repository, {
      now: (): Date => new Date('2026-10-01T12:00:01.000Z'),
    })
    const gained = parseBattleDropNotification(command)
    const lost = parseBattleDropNotification({ ...command, role: 'LOST', recipientId: 'loser' })
    expect((await useCase.execute(gained)).outcome).toBe('created')
    expect((await useCase.execute(gained)).outcome).toBe('duplicated')
    expect((await useCase.execute(lost)).outcome).toBe('created')
    const winner = await repository.findPendingForPlayer('winner')
    const loser = await repository.findPendingForPlayer('loser')
    expect(winner).toHaveLength(1)
    expect(loser).toHaveLength(1)
    expect(winner[0]?.changeType).toBe(CatalogChangeType.BattleDropGained)
    expect(loser[0]?.changeType).toBe(CatalogChangeType.BattleDropLost)
    expect(winner[0]?.sourceEventId).toBe('battle-1:2')
  })

  it('rechaza una carga sin fecha de acreditación válida', () => {
    expect(() => parseBattleDropNotification({ ...command, creditedAt: 'nonsense' })).toThrow()
  })
})
