import { CognitoJwtVerifier } from 'aws-jwt-verify'
import {
  isRole,
  IdentityVerificationError,
  type IdentityVerifierPort,
  type Role,
  type VerifiedIdentity,
} from '../../application/ports/IdentityVerifierPort.js'

export interface CognitoIdentityVerifierOptions {
  readonly userPoolId: string
  readonly clientId: string
}

/**
 * Verificador de testimonios de Cognito para la superficie HTTP de HU-38.
 *
 * Mismo patrón que `CognitoTokenVerifier` de Catalog: la comprobación de
 * firma la hace `aws-jwt-verify` contra el JWKS del pool -no se reimplementa
 * a mano-, y se verifica el token de ACCESO, no el de identidad.
 */
export class CognitoIdentityVerifier implements IdentityVerifierPort {
  private readonly verifier: ReturnType<typeof CognitoJwtVerifier.create>

  constructor(options: CognitoIdentityVerifierOptions) {
    this.verifier = CognitoJwtVerifier.create({
      userPoolId: options.userPoolId,
      clientId: options.clientId,
      tokenUse: 'access',
    })
  }

  async warmUp(): Promise<void> {
    await this.verifier.hydrate()
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    let payload: Awaited<ReturnType<typeof this.verifier.verify>>

    try {
      payload = await this.verifier.verify(token)
    } catch {
      throw new IdentityVerificationError()
    }

    return toVerifiedIdentity(payload)
  }
}

export const toVerifiedIdentity = (payload: Record<string, unknown>): VerifiedIdentity => {
  const subject = payload['sub']

  if (typeof subject !== 'string' || subject.length === 0) {
    throw new IdentityVerificationError()
  }

  return { subject, roles: readRoles(payload) }
}

const readRoles = (payload: Record<string, unknown>): ReadonlySet<Role> => {
  const groups = payload['cognito:groups']
  const roles = new Set<Role>()

  if (!Array.isArray(groups)) {
    return roles
  }

  for (const group of groups) {
    if (typeof group === 'string' && isRole(group)) {
      roles.add(group)
    }
  }

  return roles
}
