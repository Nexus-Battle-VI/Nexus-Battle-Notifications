import { describe, expect, it } from '@jest/globals'
import { InMemoryBannerRepository } from '../../../src/adapters/persistence/InMemoryBannerRepository.js'
import { CreateBannerEntry } from '../../../src/application/use-cases/CreateBannerEntry.js'
import { ListBanners } from '../../../src/application/use-cases/ListBanners.js'
import { DomainError } from '../../../src/domain/errors/DomainError.js'

class FixedClock {
  private readonly at: Date

  constructor(at: Date) {
    this.at = at
  }

  now(): Date {
    return this.at
  }
}

const NOW = new Date('2026-08-22T00:00:00.000Z')

describe('CreateBannerEntry + ListBanners', () => {
  it('CA: crea una entrada valida y aparece entre las vigentes durante su periodo', async () => {
    const banners = new InMemoryBannerRepository()
    const clock = new FixedClock(NOW)
    const create = new CreateBannerEntry({ banners, clock })
    const list = new ListBanners({ banners, clock })

    await create.execute(
      {
        title: 'Evento especial',
        content: 'Doble experiencia este fin de semana',
        publishAt: '2026-08-21T00:00:00.000Z',
        expiresAt: '2026-08-23T00:00:00.000Z',
      },
      'admin-1',
    )

    const active = await list.active()
    expect(active).toHaveLength(1)
    expect(active[0]?.title).toBe('Evento especial')
  })

  it('una entrada futura queda registrada pero no aparece entre las vigentes', async () => {
    const banners = new InMemoryBannerRepository()
    const clock = new FixedClock(NOW)
    const create = new CreateBannerEntry({ banners, clock })
    const list = new ListBanners({ banners, clock })

    await create.execute(
      {
        title: 'x',
        content: 'y',
        publishAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-09-03T00:00:00.000Z',
      },
      'admin-1',
    )

    expect(await list.active()).toEqual([])
    const all = await list.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.isActive).toBe(false)
  })

  it('una entrada expirada no aparece entre las vigentes y no se borra fisicamente', async () => {
    const banners = new InMemoryBannerRepository()
    const clock = new FixedClock(NOW)
    const create = new CreateBannerEntry({ banners, clock })
    const list = new ListBanners({ banners, clock })

    await create.execute(
      {
        title: 'x',
        content: 'y',
        publishAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2026-08-10T00:00:00.000Z',
      },
      'admin-1',
    )

    expect(await list.active()).toEqual([])
    expect(await list.all()).toHaveLength(1)
  })

  it('rechaza una entrada con publicacion posterior a la expiracion', async () => {
    const banners = new InMemoryBannerRepository()
    const clock = new FixedClock(NOW)
    const create = new CreateBannerEntry({ banners, clock })

    await expect(
      create.execute(
        {
          title: 'x',
          content: 'y',
          publishAt: '2026-08-25T00:00:00.000Z',
          expiresAt: '2026-08-20T00:00:00.000Z',
        },
        'admin-1',
      ),
    ).rejects.toThrow(DomainError)

    expect(await banners.findAll()).toEqual([])
  })

  it('permite multiples entradas vigentes simultaneas', async () => {
    const banners = new InMemoryBannerRepository()
    const clock = new FixedClock(NOW)
    const create = new CreateBannerEntry({ banners, clock })
    const list = new ListBanners({ banners, clock })

    await create.execute(
      {
        title: 'a',
        content: 'a',
        publishAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2026-09-01T00:00:00.000Z',
      },
      'admin-1',
    )
    await create.execute(
      {
        title: 'b',
        content: 'b',
        publishAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2026-09-01T00:00:00.000Z',
      },
      'admin-2',
    )

    expect(await list.active()).toHaveLength(2)
  })
})
