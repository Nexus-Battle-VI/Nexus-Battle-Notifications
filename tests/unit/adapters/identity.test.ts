import { describe, expect, it } from '@jest/globals'
import { toVerifiedIdentity } from '../../../src/adapters/identity/CognitoIdentityVerifier.js'
import {
  IdentityVerificationError,
  Role,
} from '../../../src/application/ports/IdentityVerifierPort.js'
import { UnavailableProductOwnersResolver } from '../../../src/adapters/identity/UnavailableProductOwnersResolver.js'

describe('toVerifiedIdentity', () => {
  it('extrae subject y roles reconocidos', () => {
    const identity = toVerifiedIdentity({
      sub: 'jugador-1',
      'cognito:groups': ['ADMINISTRATOR', 'PLAYER'],
    })

    expect(identity.subject).toBe('jugador-1')
    expect(identity.roles.has(Role.Administrator)).toBe(true)
    expect(identity.roles.has(Role.Player)).toBe(true)
  })

  it('descarta grupos desconocidos en silencio', () => {
    const identity = toVerifiedIdentity({ sub: 'jugador-1', 'cognito:groups': ['GRUPO_INVENTADO'] })

    expect(identity.roles.size).toBe(0)
  })

  it('sin sub lanza IdentityVerificationError', () => {
    expect(() => toVerifiedIdentity({})).toThrow(IdentityVerificationError)
  })

  it('sin cognito:groups devuelve roles vacios', () => {
    const identity = toVerifiedIdentity({ sub: 'jugador-1' })

    expect(identity.roles.size).toBe(0)
  })
})

describe('UnavailableProductOwnersResolver', () => {
  it('declara la resolucion no disponible, sin acceder a ninguna base de datos ajena', async () => {
    const resolver = new UnavailableProductOwnersResolver()
    const resolution = await resolver.resolveOwners('producto-1')

    expect(resolution.available).toBe(false)
  })
})
