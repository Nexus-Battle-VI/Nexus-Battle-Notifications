/**
 * Resuelve qué jugadores poseen un producto, para dirigir notificaciones de
 * suspensión/reactivación (HU-38) únicamente a quienes lo poseen.
 *
 * BRECHA CONOCIDA (ver informe de entrega de HU-38): a fecha de esta
 * implementación, Player-Inventory NO expone ningún contrato -API interna,
 * evento o proyección- que permita resolver "¿qué jugadores poseen el
 * producto X?". Su superficie HTTP actual (`GET /api/inventories/:ownerId`,
 * `GET /api/inventories/me/items`) solo resuelve la dirección contraria:
 * dado un jugador, qué posee. No existe el lookup inverso.
 *
 * Notifications NO tiene permitido acceder directamente a la base de datos de
 * Player-Inventory (frontera de contexto, ver ADR-005 de Infrastructure), así
 * que este puerto queda sin una implementación real hasta que
 * Player-Inventory/Infrastructure definan ese contrato -por ejemplo
 * `GET /api/internal/v1/inventory/products/:productId/owners`, firmado con el
 * mismo mecanismo HMAC servicio-a-servicio que ya usa Commerce→Catalog-.
 *
 * Mientras tanto, `UnavailableProductOwnersResolver` es la única
 * implementación: declara la resolución "no disponible" en vez de simular una
 * lista de jugadores o acceder a una base de datos ajena.
 */
export interface ProductOwnersResolverPort {
  /**
   * Devuelve `available: false` cuando el contrato de resolución no existe
   * todavía (no cuando la lista de propietarios está vacía: eso es
   * `available: true, playerIds: []`).
   */
  resolveOwners(productId: string): Promise<ProductOwnersResolution>
}

export type ProductOwnersResolution =
  | { readonly available: true; readonly playerIds: readonly string[] }
  | { readonly available: false; readonly reason: string }
