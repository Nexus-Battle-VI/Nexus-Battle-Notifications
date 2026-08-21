import { DomainError } from '../errors/DomainError.js'

/**
 * Direccion de correo electronico validada.
 *
 * Se valida en el limite del dominio para que ninguna capa superior pueda
 * construir una notificacion con un destinatario invalido.
 */
export class EmailAddress {
  static readonly MAX_LENGTH = 254

  private static readonly PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: string): EmailAddress {
    const normalized = raw.trim().toLowerCase()

    if (normalized.length === 0) {
      throw new DomainError('La direccion de correo no puede estar vacia.')
    }

    if (normalized.length > EmailAddress.MAX_LENGTH) {
      throw new DomainError(
        `La direccion de correo supera ${String(EmailAddress.MAX_LENGTH)} caracteres.`,
      )
    }

    if (!EmailAddress.PATTERN.test(normalized)) {
      throw new DomainError(`La direccion de correo "${raw}" no tiene un formato valido.`)
    }

    return new EmailAddress(normalized)
  }

  get domain(): string {
    const parts = this.value.split('@')
    return parts[1] ?? ''
  }

  equals(other: EmailAddress): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}
