import type {
  HandleCatalogProductCreated,
  HandleCatalogProductCreatedResult,
} from './HandleCatalogProductCreated.js'
import type { HandleCatalogProductCreatedInApp } from './HandleCatalogProductCreatedInApp.js'
import type { CatalogProductCreatedEvent } from '../dto/CatalogProductCreatedEvent.js'

export interface HandleCatalogProductCreatedNotificationsDependencies {
  readonly emailUseCase: HandleCatalogProductCreated
  readonly inAppUseCase: HandleCatalogProductCreatedInApp
}

/**
 * Compone las dos reacciones a `catalog.product.created` sobre EL MISMO
 * mensaje de cola: el correo transaccional heredado de HU-33.10
 * (`HandleCatalogProductCreated`, sin tocar) y la notificación in-app que
 * exige HU-38 (`HandleCatalogProductCreatedInApp`).
 *
 * Existe porque `MessageQueuePort` tiene semántica de consumidor competitivo:
 * una vez que un `receive()` entrega el mensaje, `acknowledge()` lo retira
 * para cualquier otro lector. Dos consumidores separados sondeando la MISMA
 * cola por separado se robarían mensajes entre sí -no es fan-out, es
 * competencia-, así que ambas reacciones tienen que vivir dentro de la
 * ejecución de un único consumidor (`CatalogProductEventsConsumer`, sin
 * modificar). Esta clase implementa exactamente su mismo contrato
 * (`execute({event, deliveryAttempt}) -> HandleCatalogProductCreatedResult`)
 * para poder sustituir a `HandleCatalogProductCreated` en la composición sin
 * tocar el consumidor.
 *
 * Cada rama tiene su propia clave de idempotencia (ver ambos casos de uso), así
 * que un reintento tras un fallo de una de las dos no repite la que ya tuvo
 * éxito: esta vuelve a ejecutarse pero su propio store de idempotencia la
 * resuelve como duplicada de inmediato.
 */
export class HandleCatalogProductCreatedNotifications {
  private readonly deps: HandleCatalogProductCreatedNotificationsDependencies

  constructor(deps: HandleCatalogProductCreatedNotificationsDependencies) {
    this.deps = deps
  }

  async execute(params: {
    event: CatalogProductCreatedEvent
    deliveryAttempt: number
  }): Promise<HandleCatalogProductCreatedResult> {
    const emailResult = await this.deps.emailUseCase.execute(params)

    // Un correo cuyo intento se agota o se reintenta es la señal de retorno:
    // el mensaje no debe confirmarse todavía, sin importar si la parte in-app
    // ya se registró (es idempotente y no se pierde en un reintento).
    if (emailResult.outcome === 'retry') {
      return emailResult
    }

    await this.deps.inAppUseCase.execute(params.event)

    return emailResult
  }
}
