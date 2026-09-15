import type { GlobalNotificationReceiptRepositoryPort } from '../../application/ports/GlobalNotificationReceiptRepositoryPort.js'

export class InMemoryGlobalNotificationReceiptRepository implements GlobalNotificationReceiptRepositoryPort {
  private readonly readByPlayer = new Map<string, Set<string>>()

  findReadNotificationIds(
    playerId: string,
    notificationIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const read = this.readByPlayer.get(playerId) ?? new Set<string>()

    return Promise.resolve(new Set(notificationIds.filter((id) => read.has(id))))
  }

  markRead(playerId: string, notificationIds: readonly string[]): Promise<void> {
    const read = this.readByPlayer.get(playerId) ?? new Set<string>()

    for (const id of notificationIds) {
      read.add(id)
    }

    this.readByPlayer.set(playerId, read)

    return Promise.resolve()
  }
}
