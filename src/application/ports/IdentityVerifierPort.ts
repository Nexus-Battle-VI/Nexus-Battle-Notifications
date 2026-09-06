/**
 * Puerto de verificación de identidad para la superficie HTTP de HU-38.
 *
 * Notifications no tenía ningún endpoint autenticado antes de HU-38 (su
 * único tramo HTTP previo, `purchase-server.ts`, usa la firma HMAC
 * servicio-a-servicio, no un testimonio de jugador). Este puerto y su
 * vocabulario de roles se duplican deliberadamente desde el mismo patrón que
 * usan Account/Catalog (`TokenVerifierPort`): un paquete de identidad
 * compartido acoplaría los servicios y volvería el límite de contexto
 * cosmético. Ver ADR-004 de Infrastructure.
 */
export const Role = {
  Player: 'PLAYER',
  Moderator: 'MODERATOR',
  Administrator: 'ADMINISTRATOR',
  SuperAdministrator: 'SUPER_ADMINISTRATOR',
} as const

export type Role = (typeof Role)[keyof typeof Role]

export const ALL_ROLES: readonly Role[] = [
  Role.Player,
  Role.Moderator,
  Role.Administrator,
  Role.SuperAdministrator,
]

export const isRole = (value: string): value is Role =>
  (ALL_ROLES as readonly string[]).includes(value)

export interface VerifiedIdentity {
  /** `sub` del proveedor: identidad estable del jugador autenticado. */
  readonly subject: string
  readonly roles: ReadonlySet<Role>
}

export interface IdentityVerifierPort {
  verify(token: string): Promise<VerifiedIdentity>
}

/** Deliberadamente sin detalle: el motivo exacto de un testimonio inválido es información útil para quien lo falsifica. */
export class IdentityVerificationError extends Error {
  constructor(message = 'El testimonio de identidad no es válido.') {
    super(message)
    this.name = 'IdentityVerificationError'
  }
}

/**
 * SUPER_ADMINISTRATOR satisface cualquier comprobación que exija
 * ADMINISTRATOR (jerarquía RBAC ya establecida en Catalog/Account). MODERATOR
 * NO está autorizado a administrar el banner: HU-38 solo nombra Admin y Super
 * Admin.
 */
export const satisfies = (roles: ReadonlySet<Role>, required: Role): boolean => {
  if (roles.has(required)) {
    return true
  }

  return required === Role.Administrator && roles.has(Role.SuperAdministrator)
}
