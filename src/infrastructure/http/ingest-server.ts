import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

import {
  InvalidMessageError,
  parseNotificationMessage,
} from '../../adapters/messaging/NotificationMessageParser.js'
import type { Logger } from '../observability/logger.js'

/** Ruta unica de ingesta. Cualquier otra devuelve 404. */
export const INGEST_PATH = '/notifications'

/**
 * Tope del cuerpo aceptado. Una notificacion son unos cientos de bytes; 64 KiB
 * deja margen de sobra y evita que una peticion sin fin agote la memoria del
 * worker.
 */
export const MAX_BODY_BYTES = 64 * 1024

export interface IngestServerOptions {
  readonly port: number
  readonly logger: Logger
  /**
   * Encola el cuerpo ya validado y devuelve el identificador del mensaje.
   *
   * Se recibe como funcion, y no como puerto, por el mismo motivo que
   * `readinessChecks` en el servidor de salud: es una sola operacion y asi el
   * servidor no queda atado a una implementacion de cola. La firma admite
   * resultado sincrono o asincrono para que un futuro productor SQS encaje sin
   * tocar este fichero.
   */
  readonly publish: (body: string) => string | Promise<string>
  /**
   * Secreto compartido opcional. Si se define, toda peticion debe presentarlo
   * en `x-ingest-secret`.
   *
   * POR QUE ES OPCIONAL: este servidor no publica puerto al anfitrion, asi que
   * solo es alcanzable desde la red interna de Docker; quien pueda llamarlo ya
   * esta dentro del nodo. Y el `compose` viaja dentro de `user_data`, que el
   * estado de Terraform guarda entero y sin cifrar: anadir un secreto ahi tiene
   * un coste real. Se deja disponible para quien quiera defensa en profundidad,
   * sin imponerlo.
   */
  readonly sharedSecret?: string | null
}

const respond = (response: ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/** Comparacion en tiempo constante, para no filtrar el secreto por temporizacion. */
const secretMatches = (expected: string, received: string | undefined): boolean => {
  if (received === undefined) {
    return false
  }

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')

  // `timingSafeEqual` exige la misma longitud; compararla antes ya revela la
  // longitud, que no es el secreto.
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Acumula el cuerpo con tope. Rechaza en cuanto se excede, sin llegar al final. */
const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length

    if (total > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError()
    }

    chunks.push(buffer)
  }

  return Buffer.concat(chunks).toString('utf8')
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('El cuerpo excede el tamano maximo admitido.')
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * Servidor de ingesta de notificaciones.
 *
 * Recibe de Account lo que `HttpNotificationRequester` publica y lo deposita en
 * la cola que el consumidor ya vacia. Es el tramo que faltaba entre ambos
 * contextos: hasta ahora Account registraba la solicitud en su log y ahi moria.
 *
 * DEVUELVE 202, NO 200: encolar no es enviar. El correo puede fallar despues, y
 * un 200 afirmaria una entrega que este servidor no puede garantizar.
 *
 * NO DEDUPLICA, Y ES DELIBERADO: `SendTransactionalEmail` ya reserva
 * `idempotencyKey ?? notificationId` en el almacen de idempotencia antes de
 * enviar. Si la ingesta reservara la misma clave, el consumidor encontraria la
 * reserva tomada, resolveria `Duplicated` y **descartaria en silencio todos los
 * correos**. La deduplicacion vive donde importa: justo antes del envio.
 *
 * NUNCA REGISTRA `variables`: ahi viaja el codigo de un solo uso. Se registra
 * el dominio del destinatario, no la direccion, igual que hace Account.
 */
export const createIngestServer = (options: IngestServerOptions): Server => {
  const secret = options.sharedSecret ?? null

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const url = (request.url ?? '/').split('?')[0]

      if (url !== INGEST_PATH) {
        respond(response, 404, { error: 'not_found' })
        return
      }

      if (request.method !== 'POST') {
        respond(response, 405, { error: 'method_not_allowed' })
        return
      }

      if (secret !== null) {
        const header = request.headers['x-ingest-secret']
        const received = Array.isArray(header) ? header[0] : header

        if (!secretMatches(secret, received)) {
          options.logger.warn('ingest_unauthorized', {})
          respond(response, 401, { error: 'unauthorized' })
          return
        }
      }

      let raw: string

      try {
        raw = await readBody(request)
      } catch (error: unknown) {
        if (error instanceof PayloadTooLargeError) {
          respond(response, 413, { error: 'payload_too_large' })
          return
        }

        respond(response, 400, { error: 'invalid_body' })
        return
      }

      let command
      try {
        // Se valida con el MISMO analizador que usa el consumidor de la cola:
        // un solo contrato de entrada, imposible que las dos vias diverjan.
        command = parseNotificationMessage(raw)
      } catch (error: unknown) {
        const reason =
          error instanceof InvalidMessageError ? error.message : 'Cuerpo de mensaje invalido.'

        options.logger.warn('ingest_rejected', { reason })
        respond(response, 400, { error: 'invalid_message', detail: reason })
        return
      }

      try {
        const messageId = await options.publish(raw)

        options.logger.info('ingest_accepted', {
          notificationId: command.notificationId,
          templateId: command.templateId,
          recipientDomain: command.recipient.split('@')[1] ?? 'desconocido',
          messageId,
        })

        respond(response, 202, { status: 'accepted', notificationId: command.notificationId })
      } catch (error: unknown) {
        options.logger.error('ingest_enqueue_failed', {
          notificationId: command.notificationId,
          reason: error instanceof Error ? error.message : 'Fallo desconocido',
        })

        respond(response, 503, { error: 'enqueue_failed' })
      }
    })()
  })

  server.listen(options.port, () => {
    options.logger.info('ingest_server_listening', {
      port: options.port,
      path: INGEST_PATH,
      authenticated: secret !== null,
    })
  })

  return server
}
