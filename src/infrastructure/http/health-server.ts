import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Logger } from '../observability/logger.js'
import {
  buildLiveness,
  buildReadiness,
  buildVersion,
  type ReadinessCheck,
  type VersionReport,
} from './health.js'

export interface HealthServerOptions {
  readonly port: number
  readonly logger: Logger
  readonly version: VersionReport
  readonly readinessChecks: readonly ReadinessCheck[]
  /**
   * Solo desarrollo local: publica el cuerpo en la cola en memoria.
   * En produccion no se pasa: el worker no expone API de negocio.
   */
  readonly enqueue?: (body: string) => void
}

const MAX_ENQUEUE_BYTES = 32_768

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    request.on('data', (chunk: Buffer) => {
      size += chunk.length

      if (size > MAX_ENQUEUE_BYTES) {
        reject(new Error('payload_too_large'))
        request.destroy()
        return
      }

      chunks.push(chunk)
    })
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
  })

/**
 * Servidor HTTP minimo dedicado a sondas de salud y version.
 * El worker no expone API de negocio: su entrada es la cola de mensajes.
 * `POST /dev/enqueue` solo existe cuando se inyecta `enqueue` (desarrollo).
 */
export const createHealthServer = (options: HealthServerOptions): Server => {
  const server = createServer((request, response) => {
    const url = request.url ?? '/'

    const respond = (status: number, payload: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(payload))
    }

    if (request.method === 'POST' && url === '/dev/enqueue') {
      if (options.enqueue === undefined) {
        respond(404, { error: 'not_found' })
        return
      }

      void readBody(request)
        .then((body) => {
          options.enqueue?.(body)
          respond(202, { status: 'queued' })
        })
        .catch(() => {
          respond(413, { error: 'payload_too_large' })
        })

      return
    }

    if (request.method !== 'GET') {
      respond(405, { error: 'method_not_allowed' })
      return
    }

    switch (url) {
      case '/health/live':
        respond(200, buildLiveness())
        return
      case '/health/ready': {
        const report = buildReadiness(options.readinessChecks)
        respond(report.status === 'ok' ? 200 : 503, report)
        return
      }
      case '/version':
        respond(200, buildVersion(options.version))
        return
      default:
        respond(404, { error: 'not_found' })
    }
  })

  server.listen(options.port, () => {
    options.logger.info('health_server_listening', { port: options.port })
  })

  return server
}
