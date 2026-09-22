import { createServer, type Server } from 'node:http'

import {
  InvalidAuctionBidOutbidNotificationError,
  parseAuctionBidOutbidNotification,
} from '../../application/dto/AuctionBidOutbidNotification.js'
import {
  AuctionOutbidNotificationOutcome,
  type CreateAuctionOutbidNotification,
} from '../../application/use-cases/CreateAuctionOutbidNotification.js'
import { DomainError } from '../../domain/errors/DomainError.js'
import {
  INTERNAL_CLOCK_SKEW_MS,
  signInternalRequest,
  signatureMatches,
  timestampWithinWindow,
} from '../../adapters/identity/internal-signature.js'
import type { Logger } from '../observability/logger.js'

export const AUCTION_OUTBID_PATH = '/api/internal/v1/notifications/auction/outbid'

export const MAX_AUCTION_OUTBID_BODY_BYTES = 64 * 1024

export interface AuctionOutbidServerOptions {
  readonly port: number
  readonly sharedSecret: string
  readonly useCase: CreateAuctionOutbidNotification
  readonly logger: Logger
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('El cuerpo excede el tamano maximo admitido.')

    this.name = 'PayloadTooLargeError'
  }
}

const readBody = async (request: AsyncIterable<unknown>): Promise<string> => {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))

    total += buffer.length

    if (total > MAX_AUCTION_OUTBID_BODY_BYTES) {
      throw new PayloadTooLargeError()
    }

    chunks.push(buffer)
  }

  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Endpoint interno HU-63.5.
 *
 * Solamente Auction puede solicitar una notificacion de puja
 * superada.
 *
 * La firma HMAC vincula:
 *
 * - servicio;
 * - metodo HTTP;
 * - ruta;
 * - timestamp;
 * - cuerpo.
 */
export const createAuctionOutbidServer = (options: AuctionOutbidServerOptions): Server => {
  const server = createServer((request, response) => {
    const respond = (status: number, body: unknown): void => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
      })

      response.end(JSON.stringify(body))
    }

    void (async (): Promise<void> => {
      const path = (request.url ?? '/').split('?')[0] ?? '/'

      if (path !== AUCTION_OUTBID_PATH) {
        respond(404, {
          error: 'not_found',
        })
        return
      }

      if (request.method !== 'POST') {
        respond(405, {
          error: 'method_not_allowed',
        })
        return
      }

      try {
        const raw = await readBody(request)

        const body: unknown = JSON.parse(raw)

        const service = request.headers['x-internal-service']

        const timestamp = request.headers['x-internal-timestamp']

        const signature = request.headers['x-internal-signature']

        const receivedService = Array.isArray(service) ? service[0] : service

        const receivedTimestamp = Array.isArray(timestamp) ? timestamp[0] : timestamp

        const receivedSignature = Array.isArray(signature) ? signature[0] : signature

        if (
          receivedService !== 'auction' ||
          typeof receivedTimestamp !== 'string' ||
          typeof receivedSignature !== 'string' ||
          options.sharedSecret.length === 0 ||
          !timestampWithinWindow(receivedTimestamp, new Date(), INTERNAL_CLOCK_SKEW_MS) ||
          !signatureMatches(
            signInternalRequest(options.sharedSecret, {
              service: receivedService,
              method: 'POST',
              path: AUCTION_OUTBID_PATH,
              timestamp: receivedTimestamp,
              body,
            }),
            receivedSignature,
          )
        ) {
          options.logger.warn('auction_outbid_unauthorized', {})

          respond(401, {
            error: 'unauthorized',
          })

          return
        }

        const command = parseAuctionBidOutbidNotification(body)

        const result = await options.useCase.execute(command)

        const status = result.outcome === AuctionOutbidNotificationOutcome.Created ? 201 : 200

        options.logger.info('auction_outbid_notification_accepted', {
          notificationId: result.notificationId,
          outcome: result.outcome,
          auctionId: command.auctionId,
          recipientPlayerId: command.recipientPlayerId,
        })

        respond(status, {
          notificationId: result.notificationId,
          status: result.outcome,
        })
      } catch (error: unknown) {
        if (error instanceof PayloadTooLargeError) {
          respond(413, {
            error: 'payload_too_large',
          })
          return
        }

        if (
          error instanceof SyntaxError ||
          error instanceof InvalidAuctionBidOutbidNotificationError ||
          error instanceof DomainError
        ) {
          respond(400, {
            error: 'invalid_outbid_notification',
            message: error.message,
          })
          return
        }

        options.logger.warn('auction_outbid_notification_pending', {
          reason: error instanceof Error ? error.message : 'Fallo desconocido.',
        })

        /*
         * Auction ya confirmo la puja.
         *
         * 503 significa que Notifications no pudo aceptar
         * la notificacion en este intento. Un retry de Auction
         * puede reutilizar el mismo notificationId.
         */
        respond(503, {
          error: 'notification_pending',
        })
      }
    })()
  })

  server.requestTimeout = 30_000

  server.headersTimeout = 10_000

  server.listen(options.port)

  return server
}
