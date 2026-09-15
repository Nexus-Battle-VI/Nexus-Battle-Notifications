import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { DomainError } from '../../domain/errors/DomainError.js'
import {
  IdentityVerificationError,
  Role,
  satisfies,
  type IdentityVerifierPort,
  type VerifiedIdentity,
} from '../../application/ports/IdentityVerifierPort.js'
import type { GetPlayerNotifications } from '../../application/use-cases/GetPlayerNotifications.js'
import type { MarkNotificationsRead } from '../../application/use-cases/MarkNotificationsRead.js'
import type { CreateBannerEntry } from '../../application/use-cases/CreateBannerEntry.js'
import type { ListBanners } from '../../application/use-cases/ListBanners.js'
import type { Logger } from '../observability/logger.js'

const MAX_BODY_BYTES = 16 * 1024

export interface CatalogNotificationsServerOptions {
  readonly port: number
  readonly identityVerifier: IdentityVerifierPort
  readonly getPlayerNotifications: GetPlayerNotifications
  readonly markNotificationsRead: MarkNotificationsRead
  readonly createBannerEntry: CreateBannerEntry
  readonly listBanners: ListBanners
  readonly logger: Logger
}

const respond = (response: ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

const readBody = async (request: IncomingMessage): Promise<unknown> => {
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

  const raw = Buffer.concat(chunks).toString('utf8')

  return raw.length === 0 ? {} : JSON.parse(raw)
}

class PayloadTooLargeError extends Error {}

const bearerToken = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization

  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null
  }

  const token = header.slice('Bearer '.length).trim()

  return token.length === 0 ? null : token
}

/**
 * Superficie HTTP HU-38.3/HU-38.4.
 *
 * Primer endpoint autenticado por testimonio de jugador de Notifications
 * (`purchase-server.ts` usa HMAC servicio-a-servicio, no JWT). El playerId
 * SIEMPRE se toma de `VerifiedIdentity.subject`, nunca de la URL o del cuerpo:
 * un jugador jamás puede leer, marcar o listar notificaciones de otro
 * -sección 5 del encargo-.
 */
export const createCatalogNotificationsServer = (
  options: CatalogNotificationsServerOptions,
): Server => {
  const authenticate = async (request: IncomingMessage): Promise<VerifiedIdentity | null> => {
    const token = bearerToken(request)

    if (token === null) {
      return null
    }

    try {
      return await options.identityVerifier.verify(token)
    } catch (error: unknown) {
      if (error instanceof IdentityVerificationError) {
        return null
      }

      throw error
    }
  }

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const url = (request.url ?? '/').split('?')[0] ?? '/'
      const method = request.method ?? 'GET'

      try {
        if (url === '/api/v1/banners' && method === 'GET') {
          respond(response, 200, { items: await options.listBanners.active() })
          return
        }

        if (url === '/api/v1/notifications/me/pending' && method === 'GET') {
          const identity = await authenticate(request)
          if (identity === null) {
            respond(response, 401, { error: 'unauthorized' })
            return
          }
          respond(response, 200, {
            items: await options.getPlayerNotifications.pending(identity.subject),
          })
          return
        }

        if (url === '/api/v1/notifications/me/history' && method === 'GET') {
          const identity = await authenticate(request)
          if (identity === null) {
            respond(response, 401, { error: 'unauthorized' })
            return
          }
          respond(response, 200, {
            items: await options.getPlayerNotifications.history(identity.subject),
          })
          return
        }

        if (url === '/api/v1/notifications/me/read' && method === 'POST') {
          const identity = await authenticate(request)
          if (identity === null) {
            respond(response, 401, { error: 'unauthorized' })
            return
          }
          const body = await readBody(request)
          const notificationIds = extractNotificationIds(body)
          await options.markNotificationsRead.execute(identity.subject, notificationIds)
          respond(response, 200, { status: 'ok' })
          return
        }

        if (url === '/api/v1/admin/banners' && method === 'GET') {
          const identity = await authenticate(request)
          if (identity === null) {
            respond(response, 401, { error: 'unauthorized' })
            return
          }
          if (!satisfies(identity.roles, Role.Administrator)) {
            respond(response, 403, { error: 'forbidden' })
            return
          }
          respond(response, 200, { items: await options.listBanners.all() })
          return
        }

        if (url === '/api/v1/admin/banners' && method === 'POST') {
          const identity = await authenticate(request)
          if (identity === null) {
            respond(response, 401, { error: 'unauthorized' })
            return
          }
          if (!satisfies(identity.roles, Role.Administrator)) {
            respond(response, 403, { error: 'forbidden' })
            return
          }
          const body = await readBody(request)
          const command = extractBannerCommand(body)
          const id = await options.createBannerEntry.execute(command, identity.subject)
          respond(response, 201, { id })
          return
        }

        respond(response, 404, { error: 'not_found' })
      } catch (error: unknown) {
        if (error instanceof PayloadTooLargeError) {
          respond(response, 413, { error: 'payload_too_large' })
          return
        }

        if (error instanceof SyntaxError || error instanceof DomainError) {
          respond(response, 400, {
            error: 'invalid_request',
            message: error instanceof Error ? error.message : 'Cuerpo invalido.',
          })
          return
        }

        options.logger.error('catalog_notifications_http_failed', {
          url,
          method,
          reason: error instanceof Error ? error.message : 'Fallo desconocido.',
        })
        respond(response, 500, { error: 'internal_error' })
      }
    })()
  })

  server.requestTimeout = 30000
  server.headersTimeout = 10000
  server.listen(options.port, () => {
    options.logger.info('catalog_notifications_server_listening', { port: options.port })
  })

  return server
}

const extractNotificationIds = (body: unknown): readonly string[] => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError('El cuerpo debe ser un objeto JSON.')
  }

  const ids = (body as Record<string, unknown>)['notificationIds']

  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
    throw new DomainError(
      'notificationIds debe ser una lista no vacia de identificadores de texto.',
    )
  }

  return ids
}

const extractBannerCommand = (
  body: unknown,
): { title: string; content: string; publishAt: string; expiresAt: string } => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError('El cuerpo debe ser un objeto JSON.')
  }

  const record = body as Record<string, unknown>
  const title = record['title']
  const content = record['content']
  const publishAt = record['publishAt']
  const expiresAt = record['expiresAt']

  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new DomainError('title es obligatorio.')
  }

  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new DomainError('content es obligatorio.')
  }

  if (typeof publishAt !== 'string' || Number.isNaN(Date.parse(publishAt))) {
    throw new DomainError('publishAt debe ser una fecha ISO-8601 valida.')
  }

  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    throw new DomainError('expiresAt debe ser una fecha ISO-8601 valida.')
  }

  return { title, content, publishAt, expiresAt }
}
