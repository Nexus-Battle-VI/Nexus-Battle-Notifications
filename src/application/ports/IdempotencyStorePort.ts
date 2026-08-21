/**
 * Puerto de idempotencia del consumidor.
 *
 * Materializa el patron Idempotent Consumer: una cola con entrega "al menos una
 * vez" puede reintroducir el mismo mensaje, y el correo no debe enviarse dos
 * veces.
 */
export interface IdempotencyStorePort {
  /**
   * Reserva la clave para su procesamiento.
   * Devuelve `true` si la reserva se obtuvo y `false` si ya estaba registrada.
   */
  reserve(key: string, ttlMs: number): Promise<boolean>

  /** Confirma la clave como procesada de forma definitiva. */
  confirm(key: string): Promise<void>

  /** Libera la reserva para permitir un reintento posterior. */
  release(key: string): Promise<void>
}
