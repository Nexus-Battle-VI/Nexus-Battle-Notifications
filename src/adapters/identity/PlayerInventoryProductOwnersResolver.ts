import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from './internal-signature.js'
import type {
  ProductOwnersResolution,
  ProductOwnersResolverPort,
} from '../../application/ports/ProductOwnersResolverPort.js'

const SERVICE_NAME = 'notifications'

export interface PlayerInventoryProductOwnersResolverOptions {
  /** URL interna de Player-Inventory, sin barra final. */
  readonly baseUrl: string
  /** Mismo `INTERNAL_SERVICE_AUTH_SECRET` compartido que ya usa `purchase-server.ts` para verificar a Commerce. */
  readonly secret: string
  readonly timeoutMs: number
  /** Inyectable para pruebas; por defecto el `fetch` global de Node. */
  readonly fetch?: typeof fetch
}

/**
 * Adaptador real de `ProductOwnersResolverPort` contra
 * `GET /api/internal/v1/inventory/products/{productId}/owners` de
 * Player-Inventory (`Nexus-Battle-Player-Inventory#23`).
 *
 * Reutiliza `internal-signature.ts` -ya presente en este servicio porque
 * `purchase-server.ts` lo usa para VERIFICAR la firma de Commerce- para
 * FIRMAR esta llamada saliente: es la misma función, solo que ahora la usa
 * como cliente en vez de como servidor. No se crea un segundo esquema de
 * firma.
 *
 * Todo fallo -red, timeout, JSON ilegible, forma de respuesta inesperada,
 * cualquier código HTTP que no sea 200- se traduce a `available: false`,
 * NUNCA a `playerIds: []`: confundir "no se pudo preguntar" con "no tiene
 * propietarios" perdería notificaciones en silencio (ver
 * ProductOwnersResolverPort.ts).
 */
export class PlayerInventoryProductOwnersResolver implements ProductOwnersResolverPort {
  private readonly baseUrl: string
  private readonly secret: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: PlayerInventoryProductOwnersResolverOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.secret = options.secret
    this.timeoutMs = options.timeoutMs
    this.fetchImpl = options.fetch ?? fetch
  }

  async resolveOwners(productId: string): Promise<ProductOwnersResolution> {
    const path = `/api/internal/v1/inventory/products/${encodeURIComponent(productId)}/owners`
    const timestamp = String(Date.now())
    const signature = signInternalRequest(this.secret, {
      service: SERVICE_NAME,
      method: 'GET',
      path,
      timestamp,
      // Cuerpo vacío para un GET: el servidor normaliza `request.body` ausente
      // a `{}` antes de firmar (ver InternalServiceGuard de Player-Inventory),
      // así que la firma tiene que calcularse sobre ese mismo `{}`.
      body: {},
    })

    let response: Response

    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          [INTERNAL_SERVICE_HEADER]: SERVICE_NAME,
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signature,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error: unknown) {
      return unavailable(productId, error instanceof Error ? error.message : String(error))
    }

    if (!response.ok) {
      return unavailable(productId, `respuesta ${String(response.status)} de Player-Inventory`)
    }

    let payload: unknown

    try {
      payload = await response.json()
    } catch (error: unknown) {
      return unavailable(
        productId,
        `respuesta ilegible de Player-Inventory: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return parseOwners(productId, payload)
  }
}

const unavailable = (productId: string, reason: string): ProductOwnersResolution => ({
  available: false,
  reason: `No se pudo resolver propietarios de "${productId}" en Player-Inventory: ${reason}.`,
})

/**
 * Valida la forma mínima de `{ productId, owners: [{ playerId }] }` antes de
 * confiar en ella. Una respuesta con forma inesperada se trata como fallo
 * (`available: false`), no como "sin propietarios": Player-Inventory pudo
 * haber cambiado de contrato sin que este adaptador se enterase, y eso no es
 * lo mismo que un producto real sin dueños.
 */
const parseOwners = (productId: string, payload: unknown): ProductOwnersResolution => {
  if (typeof payload !== 'object' || payload === null) {
    return unavailable(productId, 'el cuerpo de la respuesta no es un objeto JSON')
  }

  const responseProductId = (payload as { productId?: unknown }).productId

  // Player-Inventory normaliza el productId a minusculas (ItemId.create); se
  // compara igual aqui para no tratar esa normalizacion como una inconsistencia.
  if (
    typeof responseProductId !== 'string' ||
    responseProductId.toLowerCase() !== productId.toLowerCase()
  ) {
    // Player-Inventory devuelve el productId que resolvio, y debe coincidir
    // con el pedido. Que no coincida es una senal de contrato roto -no de que
    // el producto carezca de propietarios-, y no debe deducirse en silencio.
    return unavailable(
      productId,
      `la respuesta corresponde a un productId distinto ("${String(responseProductId)}")`,
    )
  }

  const owners = (payload as { owners?: unknown }).owners

  if (!Array.isArray(owners)) {
    return unavailable(productId, 'el campo "owners" no es una lista')
  }

  const playerIds: string[] = []

  for (const owner of owners) {
    const playerId = (owner as { playerId?: unknown } | null)?.playerId

    if (typeof playerId !== 'string' || playerId.length === 0) {
      return unavailable(productId, 'un elemento de "owners" no trae "playerId" de texto')
    }

    playerIds.push(playerId)
  }

  return { available: true, playerIds }
}
