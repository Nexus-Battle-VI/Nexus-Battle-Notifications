import { DomainError } from '../errors/DomainError.js'

/**
 * Identidad de una notificacion. Se genera fuera del dominio (puerto de
 * identidad o mensaje entrante) para mantener el dominio determinista.
 */
export class NotificationId {
  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: string): NotificationId {
    const normalized = raw.trim()

    if (normalized.length === 0) {
      throw new DomainError('El identificador de la notificacion no puede estar vacio.')
    }

    return new NotificationId(normalized)
  }

  equals(other: NotificationId): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}
