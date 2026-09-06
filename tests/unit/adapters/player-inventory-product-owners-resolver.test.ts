import { describe, expect, it, jest } from '@jest/globals'
import { PlayerInventoryProductOwnersResolver } from '../../../src/adapters/identity/PlayerInventoryProductOwnersResolver.js'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
  timestampWithinWindow,
} from '../../../src/adapters/identity/internal-signature.js'

const SECRET = 'test-only-secret'
const BASE_URL = 'http://player-inventory.internal:3002'
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'
const PATH = `/api/internal/v1/inventory/products/${PRODUCT_ID}/owners`

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const buildResolver = (fetchImpl: typeof fetch): PlayerInventoryProductOwnersResolver =>
  new PlayerInventoryProductOwnersResolver({
    baseUrl: BASE_URL,
    secret: SECRET,
    timeoutMs: 500,
    fetch: fetchImpl,
  })

describe('PlayerInventoryProductOwnersResolver', () => {
  it('0 propietarios: available=true con lista vacia, no un fallo', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ productId: PRODUCT_ID, owners: [] })),
    )
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toEqual({ available: true, playerIds: [] })
  })

  it('1 propietario', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ productId: PRODUCT_ID, owners: [{ playerId: 'jugador-a' }] })),
    )
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toEqual({ available: true, playerIds: ['jugador-a'] })
  })

  it('multiples propietarios, en el mismo orden que Player-Inventory sin reintroducir duplicados', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({
          productId: PRODUCT_ID,
          owners: [{ playerId: 'jugador-a' }, { playerId: 'jugador-b' }],
        }),
      ),
    )
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toEqual({ available: true, playerIds: ['jugador-a', 'jugador-b'] })
  })

  it('no duplica un playerId que Player-Inventory ya envio una sola vez (no se reintroduce deduplicacion inventada, se confia y se pasa)', async () => {
    // Player-Inventory ya garantiza unicidad (ver #23); este adaptador no
    // debe "arreglar" ni ocultar si algun dia dejara de hacerlo -eso seria un
    // fallo de contrato que este test haría invisible-, así que se limita a
    // pasar la lista tal cual.
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ productId: PRODUCT_ID, owners: [{ playerId: 'jugador-a' }] })),
    )
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toEqual({ available: true, playerIds: ['jugador-a'] })
  })

  it('construye la URL interna correcta', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ productId: PRODUCT_ID, owners: [] })),
    )
    await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE_URL}${PATH}`)
  })

  it('firma HMAC correcta: reproducible con la misma cadena canonica que verifica Player-Inventory', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ productId: PRODUCT_ID, owners: [] })),
    )
    await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers[INTERNAL_SERVICE_HEADER]).toBe('notifications')

    const timestamp = headers[INTERNAL_TIMESTAMP_HEADER]
    expect(timestamp).toBeDefined()
    expect(timestampWithinWindow(timestamp!, new Date(), 5_000)).toBe(true)

    const expectedSignature = signInternalRequest(SECRET, {
      service: 'notifications',
      method: 'GET',
      path: PATH,
      timestamp: timestamp!,
      body: {},
    })
    expect(headers[INTERNAL_SIGNATURE_HEADER]).toBe(expectedSignature)
  })

  it('timeout: se traduce a available=false, no a lista vacia', async () => {
    const fetchImpl = jest.fn<typeof fetch>((_url, init) => {
      const signal = init!.signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result.available).toBe(false)
  })

  it('error de red: available=false con motivo, sin lanzar', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED')))
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toMatchObject({ available: false })
    if (!result.available) {
      expect(result.reason).toContain('ECONNREFUSED')
    }
  })

  it('401 (firma rechazada por Player-Inventory): available=false', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    )
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toMatchObject({ available: false })
  })

  it('5xx: available=false', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 503 })),
    )
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toMatchObject({ available: false })
  })

  it('JSON invalido: available=false, no una excepcion sin capturar', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{esto no es json', { status: 200 })),
    )
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toMatchObject({ available: false })
  })

  it('productId de la respuesta inconsistente con el pedido: available=false, no se confia en la lista', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({
          productId: '99999999-9999-4999-8999-999999999999',
          owners: [{ playerId: 'jugador-a' }],
        }),
      ),
    )
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toMatchObject({ available: false })
  })

  it('un elemento de owners sin playerId de texto: available=false', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ productId: PRODUCT_ID, owners: [{}] })),
    )
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toMatchObject({ available: false })
  })

  it('owners que no es una lista: available=false', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ productId: PRODUCT_ID, owners: 'no-es-una-lista' })),
    )
    const result = await buildResolver(fetchImpl).resolveOwners(PRODUCT_ID)

    expect(result).toMatchObject({ available: false })
  })
})
