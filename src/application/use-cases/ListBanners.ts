import type { BannerRepositoryPort } from '../ports/BannerRepositoryPort.js'
import type { ClockPort } from '../ports/ClockPort.js'

export interface PresentedBanner {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly publishAt: string
  readonly expiresAt: string
}

export interface PresentedAdminBanner extends PresentedBanner {
  readonly status: string
  readonly isActive: boolean
  readonly createdBy: string
  readonly createdAt: string
}

export interface ListBannersDependencies {
  readonly banners: BannerRepositoryPort
  readonly clock: ClockPort
}

/**
 * Dos lecturas separadas a propósito (Task #181): la vista principal solo
 * necesita vigentes, la administrativa necesita ver todo -incluidas futuras y
 * expiradas- para poder gestionarlas.
 */
export class ListBanners {
  private readonly deps: ListBannersDependencies

  constructor(deps: ListBannersDependencies) {
    this.deps = deps
  }

  /** Únicamente entradas vigentes: publishAt <= ahora <= expiresAt. La regla la aplica el dominio, no esta clase. */
  async active(): Promise<readonly PresentedBanner[]> {
    const now = this.deps.clock.now()
    const candidates = await this.deps.banners.findPublishableAt(now)

    return candidates
      .filter((entry) => entry.isActiveAt(now))
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        content: entry.content,
        publishAt: entry.publishAt.toISOString(),
        expiresAt: entry.expiresAt.toISOString(),
      }))
  }

  /** Todas las entradas (futuras, vigentes y expiradas), para el panel administrativo. */
  async all(): Promise<readonly PresentedAdminBanner[]> {
    const now = this.deps.clock.now()
    const entries = await this.deps.banners.findAll()

    return entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      publishAt: entry.publishAt.toISOString(),
      expiresAt: entry.expiresAt.toISOString(),
      status: entry.status,
      isActive: entry.isActiveAt(now),
      createdBy: entry.createdBy,
      createdAt: entry.createdAt.toISOString(),
    }))
  }
}
