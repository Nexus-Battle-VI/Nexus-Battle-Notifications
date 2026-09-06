import { BannerEntry } from '../../domain/entities/BannerEntry.js'
import type { BannerRepositoryPort } from '../ports/BannerRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'

export interface CreateBannerEntryCommand {
  readonly title: string
  readonly content: string
  readonly publishAt: string
  readonly expiresAt: string
}

export interface CreateBannerEntryDependencies {
  readonly banners: BannerRepositoryPort
  readonly clock: ClockPort
}

/** Autorización (ADMINISTRATOR/SUPER_ADMINISTRATOR) se resuelve en el adaptador HTTP, no aquí: este caso de uso asume que ya fue concedida. */
export class CreateBannerEntry {
  private readonly deps: CreateBannerEntryDependencies

  constructor(deps: CreateBannerEntryDependencies) {
    this.deps = deps
  }

  async execute(command: CreateBannerEntryCommand, createdBy: string): Promise<string> {
    const entry = BannerEntry.create({
      title: command.title,
      content: command.content,
      publishAt: new Date(command.publishAt),
      expiresAt: new Date(command.expiresAt),
      createdBy,
      now: this.deps.clock.now(),
    })

    await this.deps.banners.save(entry)

    return entry.id
  }
}
