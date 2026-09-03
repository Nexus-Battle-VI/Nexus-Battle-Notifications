import { createServer, type Server } from 'node:http'
import { DomainError } from '../../domain/errors/DomainError.js'
import { PurchaseConflictError } from '../../application/ports/PurchaseInboxPort.js'
import type { SendPurchaseConfirmation } from '../../application/use-cases/SendPurchaseConfirmation.js'
import {
  signInternalRequest,
  signatureMatches,
  timestampWithinWindow,
} from '../../adapters/identity/internal-signature.js'
import type { Logger } from '../observability/logger.js'

export const PURCHASE_PATH = '/api/internal/v1/notifications/purchases'
export interface PurchaseServerOptions {
  readonly port: number
  readonly sharedSecret: string
  readonly useCase: SendPurchaseConfirmation
  readonly logger: Logger
}

export const createPurchaseServer = (options: PurchaseServerOptions): Server => {
  const server = createServer((req, res) => {
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    void (async (): Promise<void> => {
      if ((req.url ?? '').split('?')[0] !== PURCHASE_PATH) {
        respond(404, { error: 'not_found' })
        return
      }
      if (req.method !== 'POST') {
        respond(405, { error: 'method_not_allowed' })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      try {
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          size += buffer.length
          if (size > 131072) {
            respond(413, { error: 'payload_too_large' })
            return
          }
          chunks.push(buffer)
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const service = req.headers['x-internal-service']
        const timestamp = req.headers['x-internal-timestamp']
        const signature = req.headers['x-internal-signature']
        if (
          typeof service !== 'string' ||
          service !== 'commerce' ||
          typeof timestamp !== 'string' ||
          typeof signature !== 'string' ||
          options.sharedSecret.length === 0 ||
          !timestampWithinWindow(timestamp, new Date(), 30000) ||
          !signatureMatches(
            signInternalRequest(options.sharedSecret, {
              service,
              method: 'POST',
              path: PURCHASE_PATH,
              timestamp,
              body,
            }),
            signature,
          )
        ) {
          respond(401, { error: 'unauthorized' })
          return
        }
        const result = await options.useCase.execute(body)
        respond(200, result)
      } catch (error: unknown) {
        if (error instanceof SyntaxError || error instanceof DomainError) {
          respond(400, { error: 'invalid_purchase', message: error.message })
          return
        }
        if (error instanceof PurchaseConflictError) {
          respond(409, { error: 'purchase_conflict' })
          return
        }
        options.logger.warn('purchase_confirmation_pending', {})
        respond(503, { error: 'purchase_pending' })
      }
    })()
  })
  server.requestTimeout = 30000
  server.headersTimeout = 10000
  server.listen(options.port)
  return server
}
