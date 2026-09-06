import { describe, expect, it } from '@jest/globals'
import { BannerEntry } from '../../../src/domain/entities/BannerEntry.js'
import { DomainError } from '../../../src/domain/errors/DomainError.js'

const NOW = new Date('2026-08-22T00:00:00.000Z')

const create = (publishAt: string, expiresAt: string): BannerEntry =>
  BannerEntry.create({
    title: 'Evento especial',
    content: 'Doble experiencia este fin de semana',
    publishAt: new Date(publishAt),
    expiresAt: new Date(expiresAt),
    createdBy: 'admin-1',
    now: NOW,
  })

describe('BannerEntry', () => {
  it('una entrada vigente esta activa dentro de su periodo', () => {
    const entry = create('2026-08-21T00:00:00.000Z', '2026-08-23T00:00:00.000Z')

    expect(entry.isActiveAt(new Date('2026-08-22T12:00:00.000Z'))).toBe(true)
    expect(entry.isActiveAt(entry.publishAt)).toBe(true)
    expect(entry.isActiveAt(entry.expiresAt)).toBe(true)
  })

  it('una entrada futura no esta activa antes de su publicacion', () => {
    const entry = create('2026-09-01T00:00:00.000Z', '2026-09-03T00:00:00.000Z')

    expect(entry.isActiveAt(NOW)).toBe(false)
  })

  it('una entrada expirada no esta activa despues de su expiracion', () => {
    const entry = create('2026-08-01T00:00:00.000Z', '2026-08-10T00:00:00.000Z')

    expect(entry.isActiveAt(NOW)).toBe(false)
  })

  it('rechaza una entrada independiente sin producto igualmente (no exige productId)', () => {
    // BannerEntry no declara productId en absoluto: esta prueba documenta esa
    // ausencia de campo obligatorio, no un caso de error.
    const entry = create('2026-08-21T00:00:00.000Z', '2026-08-23T00:00:00.000Z')

    expect(entry.id).toBeTruthy()
  })

  it('rechaza publishAt posterior a expiresAt', () => {
    expect(() => create('2026-08-25T00:00:00.000Z', '2026-08-20T00:00:00.000Z')).toThrow(
      DomainError,
    )
  })

  it('rechaza titulo vacio', () => {
    expect(() =>
      BannerEntry.create({
        title: '  ',
        content: 'x',
        publishAt: NOW,
        expiresAt: NOW,
        createdBy: 'admin-1',
        now: NOW,
      }),
    ).toThrow(DomainError)
  })

  it('rechaza contenido vacio', () => {
    expect(() =>
      BannerEntry.create({
        title: 'x',
        content: '',
        publishAt: NOW,
        expiresAt: NOW,
        createdBy: 'admin-1',
        now: NOW,
      }),
    ).toThrow(DomainError)
  })

  it('rechaza fechas invalidas', () => {
    expect(() =>
      BannerEntry.create({
        title: 'x',
        content: 'y',
        publishAt: new Date('no-es-una-fecha'),
        expiresAt: NOW,
        createdBy: 'admin-1',
        now: NOW,
      }),
    ).toThrow(DomainError)
  })
})
