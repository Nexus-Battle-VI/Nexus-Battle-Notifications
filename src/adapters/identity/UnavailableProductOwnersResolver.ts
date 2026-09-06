import type {
  ProductOwnersResolution,
  ProductOwnersResolverPort,
} from '../../application/ports/ProductOwnersResolverPort.js'

/**
 * Única implementación existente hoy: declara que la resolución de
 * propietarios no está disponible. Ver ProductOwnersResolverPort.ts para la
 * brecha completa. NO consulta MongoDB de Player-Inventory ni simula una
 * lista de jugadores.
 */
export class UnavailableProductOwnersResolver implements ProductOwnersResolverPort {
  resolveOwners(productId: string): Promise<ProductOwnersResolution> {
    return Promise.resolve({
      available: false,
      reason: `Player-Inventory no expone todavia un contrato para resolver propietarios de "${productId}".`,
    })
  }
}
