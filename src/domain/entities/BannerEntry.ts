import { randomUUID } from 'node:crypto'
import { DomainError } from '../errors/DomainError.js'

/**
 * Estado de gestión de una entrada de banner (HU-38.4).
 *
 * Solo `PUBLISHED` existe hoy: Task #181 no exige retirar ni archivar una
 * entrada -"no es necesario borrarlas físicamente"-, así que no se inventa un
 * segundo estado sin un caso de uso que lo requiera. El campo existe porque la
 * Task lo pide explícitamente ("estado necesario para su gestión") y porque
 * añadir un valor futuro (p. ej. `WITHDRAWN`) no debe exigir una migración de
 * esquema.
 */
export const BannerEntryStatus = {
  Published: 'PUBLISHED',
} as const

export type BannerEntryStatus = (typeof BannerEntryStatus)[keyof typeof BannerEntryStatus]

export interface BannerEntrySnapshot {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly publishAt: Date
  readonly expiresAt: Date
  readonly status: BannerEntryStatus
  readonly createdBy: string
  readonly createdAt: Date
}

export interface CreateBannerEntryParams {
  readonly title: string
  readonly content: string
  readonly publishAt: Date
  readonly expiresAt: Date
  readonly createdBy: string
  readonly now: Date
  readonly id?: string
}

/**
 * Entrada del banner informativo (HU-38.4).
 *
 * Independiente de `CatalogNotification` a propósito: HU-38 exige mantener
 * separado "notificaciones automáticas de catálogo" de "banner administrado
 * manualmente" (secciones 2 y 7 del encargo). No lleva `productId` obligatorio
 * -un banner puede anunciar un evento sin producto asociado-.
 */
export class BannerEntry {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly publishAt: Date
  readonly expiresAt: Date
  readonly status: BannerEntryStatus
  readonly createdBy: string
  readonly createdAt: Date

  private constructor(params: CreateBannerEntryParams & { status: BannerEntryStatus }) {
    this.id = params.id ?? randomUUID()
    this.title = params.title
    this.content = params.content
    this.publishAt = params.publishAt
    this.expiresAt = params.expiresAt
    this.status = params.status
    this.createdBy = params.createdBy
    this.createdAt = params.now
  }

  static create(params: CreateBannerEntryParams): BannerEntry {
    const title = params.title.trim()
    const content = params.content.trim()

    if (title.length === 0) {
      throw new DomainError('El título del banner es obligatorio.')
    }

    if (content.length === 0) {
      throw new DomainError('El contenido del banner es obligatorio.')
    }

    if (Number.isNaN(params.publishAt.getTime())) {
      throw new DomainError('La fecha de publicación no es una fecha válida.')
    }

    if (Number.isNaN(params.expiresAt.getTime())) {
      throw new DomainError('La fecha de expiración no es una fecha válida.')
    }

    // fechaPublicacion <= fechaActual <= fechaExpiracion (conceptualmente):
    // aquí se valida el borde de creación, publicación <= expiración.
    if (params.publishAt.getTime() > params.expiresAt.getTime()) {
      throw new DomainError(
        'La fecha de publicación no puede ser posterior a la fecha de expiración.',
      )
    }

    if (params.createdBy.trim().length === 0) {
      throw new DomainError('createdBy es obligatorio.')
    }

    return new BannerEntry({ ...params, title, content, status: BannerEntryStatus.Published })
  }

  static fromSnapshot(snapshot: BannerEntrySnapshot): BannerEntry {
    return new BannerEntry({
      id: snapshot.id,
      title: snapshot.title,
      content: snapshot.content,
      publishAt: snapshot.publishAt,
      expiresAt: snapshot.expiresAt,
      createdBy: snapshot.createdBy,
      now: snapshot.createdAt,
      status: snapshot.status,
    })
  }

  /** fechaPublicacion <= fechaActual <= fechaExpiracion. La regla vive aquí; Web no la recalcula. */
  isActiveAt(at: Date): boolean {
    return this.publishAt.getTime() <= at.getTime() && at.getTime() <= this.expiresAt.getTime()
  }

  toSnapshot(): BannerEntrySnapshot {
    return {
      id: this.id,
      title: this.title,
      content: this.content,
      publishAt: this.publishAt,
      expiresAt: this.expiresAt,
      status: this.status,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
    }
  }
}
