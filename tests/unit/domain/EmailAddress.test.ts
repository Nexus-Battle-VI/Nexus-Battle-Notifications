import { EmailAddress } from '../../../src/domain/value-objects/EmailAddress.js'
import { DomainError } from '../../../src/domain/errors/DomainError.js'

describe('EmailAddress', () => {
  it('normaliza espacios y mayusculas', () => {
    expect(EmailAddress.create('  Jugador@Nexus.Test  ').value).toBe('jugador@nexus.test')
  })

  it('expone el dominio de la direccion', () => {
    expect(EmailAddress.create('a@nexus.test').domain).toBe('nexus.test')
  })

  it('compara por valor', () => {
    expect(EmailAddress.create('a@nexus.test').equals(EmailAddress.create('A@NEXUS.TEST'))).toBe(
      true,
    )
    expect(EmailAddress.create('a@nexus.test').equals(EmailAddress.create('b@nexus.test'))).toBe(
      false,
    )
  })

  it('se representa como texto', () => {
    expect(String(EmailAddress.create('a@nexus.test'))).toBe('a@nexus.test')
  })

  it.each([
    ['vacia', '   '],
    ['sin arroba', 'jugador.nexus.test'],
    ['sin dominio', 'jugador@'],
    ['sin punto en el dominio', 'jugador@localhost'],
    ['con espacio interno', 'jug ador@nexus.test'],
    ['con dos arrobas', 'a@b@nexus.test'],
  ])('rechaza una direccion %s', (_caso, raw) => {
    expect(() => EmailAddress.create(raw)).toThrow(DomainError)
  })

  it('rechaza una direccion mas larga que el limite', () => {
    const raw = `${'a'.repeat(250)}@nexus.test`
    expect(() => EmailAddress.create(raw)).toThrow(/supera 254 caracteres/)
  })
})
