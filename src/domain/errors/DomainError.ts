/**
 * Error de regla de negocio. No transporta detalles de infraestructura.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}
