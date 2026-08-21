import { DomainError } from '../errors/DomainError.js'

export interface RetryPolicyOptions {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}

/**
 * Politica de reintentos con retroceso exponencial acotado.
 *
 * Es una regla de negocio del contexto Notifications: define cuantas veces se
 * insiste con un proveedor de correo antes de descartar el mensaje hacia la
 * cola de mensajes fallidos. No conoce temporizadores ni infraestructura; solo
 * calcula. Quien espera es el adaptador.
 */
export class RetryPolicy {
  private readonly options: RetryPolicyOptions

  private constructor(options: RetryPolicyOptions) {
    this.options = options
  }

  static create(options: RetryPolicyOptions): RetryPolicy {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new DomainError('maxAttempts debe ser un entero mayor o igual a 1.')
    }

    if (options.baseDelayMs < 0) {
      throw new DomainError('baseDelayMs no puede ser negativo.')
    }

    if (options.maxDelayMs < options.baseDelayMs) {
      throw new DomainError('maxDelayMs no puede ser menor que baseDelayMs.')
    }

    return new RetryPolicy(options)
  }

  get maxAttempts(): number {
    return this.options.maxAttempts
  }

  shouldRetry(attempt: number, retryable: boolean): boolean {
    if (!retryable) {
      return false
    }

    return attempt < this.options.maxAttempts
  }

  /** Retroceso exponencial: base * 2^(intento-1), acotado por maxDelayMs. */
  delayForAttempt(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new DomainError('El numero de intento debe ser un entero mayor o igual a 1.')
    }

    const exponential = this.options.baseDelayMs * 2 ** (attempt - 1)

    return Math.min(exponential, this.options.maxDelayMs)
  }
}
