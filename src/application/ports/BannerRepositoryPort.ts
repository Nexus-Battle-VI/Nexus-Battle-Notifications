import type { BannerEntry } from '../../domain/entities/BannerEntry.js'

export interface BannerRepositoryPort {
  save(entry: BannerEntry): Promise<void>

  /** Todas las entradas, para la vista administrativa. Más recientes primero. */
  findAll(): Promise<readonly BannerEntry[]>

  /**
   * Candidatas a vigentes en `at`: `publishAt <= at`. El filtro fino
   * (`at <= expiresAt`) lo aplica `BannerEntry.isActiveAt` en memoria, para no
   * duplicar la regla de vigencia entre el repositorio y el dominio.
   */
  findPublishableAt(at: Date): Promise<readonly BannerEntry[]>
}
