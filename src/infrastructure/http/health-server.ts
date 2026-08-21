import { createServer, type Server } from 'node:http'
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
}

/**
 * Servidor HTTP minimo dedicado exclusivamente a sondas de salud y version.
 * El worker no expone API de negocio: su entrada es la cola de mensajes.
 */
export const createHealthServer = (options: HealthServerOptions): Server => {
  const server = createServer((request, response) => {
    const url = request.url ?? '/'

    const respond = (status: number, payload: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(payload))
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
