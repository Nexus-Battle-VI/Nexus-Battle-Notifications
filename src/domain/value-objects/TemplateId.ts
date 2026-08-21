import { DomainError } from '../errors/DomainError.js'

/**
 * Identificador de plantilla de correo. El dominio conoce que una notificacion
 * usa una plantilla, pero nunca como se renderiza.
 */
export class TemplateId {
  private static readonly PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: string): TemplateId {
    const normalized = raw.trim().toLowerCase()

    if (!TemplateId.PATTERN.test(normalized)) {
      throw new DomainError(
        `El identificador de plantilla "${raw}" no es valido. Se espera kebab-case.`,
      )
    }

    return new TemplateId(normalized)
  }

  equals(other: TemplateId): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}
