import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { createHealthServer } from '../../src/infrastructure/http/health-server.js'
import { createLogger } from '../../src/infrastructure/observability/logger.js'

interface Response {
  status: number
  body: unknown
}

const request = async (server: Server, path: string, method = 'GET'): Promise<Response> => {
  const { port } = server.address() as AddressInfo
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method })

  return { status: response.status, body: await response.json() }
}

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

const logger = createLogger({
  level: 'error',
  service: 'nexus-battle-notifications',
  version: '0.1.0',
  sink: () => undefined,
})

const version = {
  service: 'nexus-battle-notifications',
  version: '0.1.0',
  nodeEnv: 'test',
}

describe('Servidor de sondas de salud', () => {
  let server: Server
  let queueHealthy = true

  beforeAll(async () => {
    server = createHealthServer({
      port: 0,
      logger,
      version,
      readinessChecks: [
        { name: 'consumer', check: (): boolean => true },
        { name: 'queue', check: (): boolean => queueHealthy },
      ],
    })

    await new Promise((resolve) => server.once('listening', resolve))
  })

  afterAll(async () => {
    await close(server)
  })

  it('GET /health/live responde 200', async () => {
    const response = await request(server, '/health/live')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok', checks: {} })
  })

  it('GET /health/ready responde 200 cuando las dependencias estan sanas', async () => {
    queueHealthy = true
    const response = await request(server, '/health/ready')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok', checks: { consumer: 'ok', queue: 'ok' } })
  })

  it('GET /health/ready responde 503 cuando una dependencia falla', async () => {
    queueHealthy = false
    const response = await request(server, '/health/ready')

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ status: 'error', checks: { queue: 'error' } })

    queueHealthy = true
  })

  it('GET /version expone servicio, version y entorno', async () => {
    const response = await request(server, '/version')

    expect(response.status).toBe(200)
    expect(response.body).toEqual(version)
  })

  it('responde 404 en una ruta desconocida', async () => {
    expect((await request(server, '/no-existe')).status).toBe(404)
  })

  it('responde 405 ante un metodo no permitido', async () => {
    const response = await request(server, '/health/live', 'POST')

    expect(response.status).toBe(405)
    expect(response.body).toEqual({ error: 'method_not_allowed' })
  })

  it('sin enqueue, POST /dev/enqueue responde 404', async () => {
    const response = await request(server, '/dev/enqueue', 'POST')

    expect(response.status).toBe(404)
  })
})

describe('Servidor de sondas: enqueue local', () => {
  it('publica el cuerpo cuando enqueue esta inyectado', async () => {
    const published: string[] = []
    const local = createHealthServer({
      port: 0,
      logger,
      version,
      readinessChecks: [],
      enqueue: (body) => {
        published.push(body)
      },
    })

    await new Promise((resolve) => local.once('listening', resolve))

    const { port } = local.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${String(port)}/dev/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        notificationId: 'n-1',
        recipient: 'jugador@nexus.test',
        templateId: 'account-password-recovery-code',
        variables: { code: '000000' },
      }),
    })

    expect(response.status).toBe(202)
    expect(published).toHaveLength(1)
    expect(published[0]).toContain('account-password-recovery-code')

    await close(local)
  })
})
