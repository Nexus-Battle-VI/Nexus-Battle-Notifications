import type { BannerEntry } from '../../domain/entities/BannerEntry.js'
import type { BannerRepositoryPort } from '../../application/ports/BannerRepositoryPort.js'

export class InMemoryBannerRepository implements BannerRepositoryPort {
  private readonly byId = new Map<string, BannerEntry>()

  save(entry: BannerEntry): Promise<void> {
    this.byId.set(entry.id, entry)

    return Promise.resolve()
  }

  findAll(): Promise<readonly BannerEntry[]> {
    const items = [...this.byId.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )

    return Promise.resolve(items)
  }

  findPublishableAt(at: Date): Promise<readonly BannerEntry[]> {
    const items = [...this.byId.values()].filter(
      (entry) => entry.publishAt.getTime() <= at.getTime(),
    )

    return Promise.resolve(items)
  }
}
