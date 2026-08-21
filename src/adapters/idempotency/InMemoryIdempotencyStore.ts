import type { IdempotencyStorePort } from '../../application/ports/IdempotencyStorePort.js'

interface Reservation {
  readonly expiresAtMs: number
  confirmed: boolean
}

/**
 * Almacen de idempotencia en memoria con expiracion.
 *
 * Adecuado para una sola instancia del worker, que es la topologia de la demo.
 * Una topologia multiinstancia requiere un almacen compartido; esa decision
 * queda registrada como limitacion en la arquitectura de demo.
 */
export class InMemoryIdempotencyStore implements IdempotencyStorePort {
  private readonly entries = new Map<string, Reservation>()

  private readonly nowMs: () => number

  constructor(nowMs: () => number) {
    this.nowMs = nowMs
  }

  reserve(key: string, ttlMs: number): Promise<boolean> {
    const now = this.nowMs()
    const existing = this.entries.get(key)

    if (existing !== undefined && existing.expiresAtMs > now) {
      return Promise.resolve(false)
    }

    this.entries.set(key, { expiresAtMs: now + ttlMs, confirmed: false })

    return Promise.resolve(true)
  }

  confirm(key: string): Promise<void> {
    const existing = this.entries.get(key)

    if (existing !== undefined) {
      existing.confirmed = true
    }

    return Promise.resolve()
  }

  release(key: string): Promise<void> {
    this.entries.delete(key)

    return Promise.resolve()
  }

  /** Elimina las reservas vencidas. El worker la invoca periodicamente. */
  purgeExpired(): number {
    const now = this.nowMs()
    let removed = 0

    for (const [key, reservation] of this.entries) {
      if (reservation.expiresAtMs <= now) {
        this.entries.delete(key)
        removed += 1
      }
    }

    return removed
  }

  get size(): number {
    return this.entries.size
  }
}
