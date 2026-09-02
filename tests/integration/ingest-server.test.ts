import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { createIngestServer, MAX_BODY_BYTES } from '../../src/infrastructure/http/ingest-server.js'
import { createLogger } from '../../src/infrastructure/observability/logger.js'
import { InMemoryMessageQueue } from '../../src/adapters/messaging/InMemoryMessageQueue.js'
import { NotificationConsumer } from '../../src/adapters/messaging/NotificationConsumer.js'
import { InMemoryIdempotencyStore } from '../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { InMemoryTemplateRenderer } from '../../src/adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../src/adapters/templates/default-templates.js'
import { FakeEmailSender } from '../../src/adapters/email/FakeEmailSender.js'
import { LoggingEventPublisher } from '../../src/adapters/events/LoggingEventPublisher.js'
import { SendTransactionalEmail } from '../../src/application/use-cases/SendTransactionalEmail.js'
import { RetryPolicy } from '../../src/domain/policies/RetryPolicy.js'

interface Response {
  status: number
  body: unknown
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

const listening = async (server: Server): Promise<Server> => {
  await new Promise((resolve) => server.once('listening', resolve))

  return server
}

const post = async (
  server: Server,
  body: string,
  options: { path?: string; method?: string; headers?: Record<string, string> } = {},
): Promise<Response> => {
  const { port } = server.address() as AddressInfo
  const response = await fetch(
    `http://127.0.0.1:${String(port)}${options.path ?? '/notifications'}`,
    {
      method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      ...(options.method === 'GET' ? {} : { body }),
    },
  )

  return { status: response.status, body: await response.json() }
}

const logLines: string[] = []

const logger = createLogger({
  level: 'debug',
  service: 'nexus-battle-notifications',
  version: '0.1.0',
  sink: (line) => logLines.push(line),
})

const notification = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    notificationId: 'n-ingest-1',
    recipient: 'jugador@nexus.test',
    templateId: 'account-password-recovery-code',
    variables: { displayName: 'Ana', code: '424242', expiresInMinutes: 10 },
    ...overrides,
  })

describe('Servidor de ingesta de notificaciones', () => {
  let server: Server
  let queue: InMemoryMessageQueue

  beforeEach(async () => {
    logLines.length = 0
    queue = new InMemoryMessageQueue(() => 1_000)
    server = await listening(
      createIngestServer({ port: 0, logger, publish: (body) => queue.publish(body) }),
    )
  })

  afterEach(async () => {
    await close(server)
  })

  it('acepta una notificacion valida con 202 y la encola', async () => {
    const response = await post(server, notification())

    // 202 y no 200: encolar no es enviar.
    expect(response.status).toBe(202)
    expect(response.body).toEqual({ status: 'accepted', notificationId: 'n-ingest-1' })
    expect(queue.pendingCount).toBe(1)
  })

  it('encola el cuerpo intacto, sin perder las variables', async () => {
    await post(server, notification())

    const [message] = await queue.receive(1)

    expect(JSON.parse(message!.body)).toEqual({
      notificationId: 'n-ingest-1',
      recipient: 'jugador@nexus.test',
      templateId: 'account-password-recovery-code',
      variables: { displayName: 'Ana', code: '424242', expiresInMinutes: 10 },
    })
  })

  /**
   * El codigo de un solo uso viaja en `variables`. Registrarlo repetiria el
   * defecto de seguridad que ya se corrigio una vez en Account, esta vez en el
   * otro extremo del mismo trayecto.
   */
  it('NUNCA registra las variables ni la direccion completa', async () => {
    await post(server, notification())

    const registro = logLines.join('\n')

    expect(registro).toContain('ingest_accepted')
    expect(registro).not.toContain('424242')
    expect(registro).not.toContain('jugador@nexus.test')
    // El dominio si, porque no identifica a la persona.
    expect(registro).toContain('nexus.test')
  })

  it.each([
    ['cuerpo que no es JSON', '{ esto no es json'],
    ['cuerpo que es un array', '[]'],
    ['falta notificationId', JSON.stringify({ recipient: 'a@b.c', templateId: 't' })],
    ['falta recipient', JSON.stringify({ notificationId: 'n', templateId: 't' })],
    ['falta templateId', JSON.stringify({ notificationId: 'n', recipient: 'a@b.c' })],
    [
      'variables anidadas',
      JSON.stringify({
        notificationId: 'n',
        recipient: 'a@b.c',
        templateId: 't',
        variables: { anidado: { no: 'admitido' } },
      }),
    ],
  ])('rechaza con 400: %s', async (_caso, cuerpo) => {
    const response = await post(server, cuerpo)

    expect(response.status).toBe(400)
    expect(queue.pendingCount).toBe(0)
  })

  it('responde 405 ante un metodo distinto de POST', async () => {
    const response = await post(server, '', { method: 'GET' })

    expect(response.status).toBe(405)
    expect(response.body).toEqual({ error: 'method_not_allowed' })
  })

  it('responde 404 en una ruta desconocida', async () => {
    const response = await post(server, notification(), { path: '/otra-cosa' })

    expect(response.status).toBe(404)
    expect(queue.pendingCount).toBe(0)
  })

  it('ignora la cadena de consulta al enrutar', async () => {
    const response = await post(server, notification(), { path: '/notifications?origen=account' })

    expect(response.status).toBe(202)
  })

  it('rechaza con 413 un cuerpo que excede el tope', async () => {
    const enorme = JSON.stringify({
      notificationId: 'n',
      recipient: 'a@b.c',
      templateId: 't',
      variables: { relleno: 'x'.repeat(MAX_BODY_BYTES) },
    })

    const response = await post(server, enorme)

    expect(response.status).toBe(413)
    expect(queue.pendingCount).toBe(0)
  })

  it('responde 503 si encolar falla, sin dar por aceptada la notificacion', async () => {
    const roto = await listening(
      createIngestServer({
        port: 0,
        logger,
        publish: () => {
          throw new Error('cola caida')
        },
      }),
    )

    try {
      const response = await post(roto, notification())

      expect(response.status).toBe(503)
      expect(response.body).toEqual({ error: 'enqueue_failed' })
    } finally {
      await close(roto)
    }
  })
})

describe('Servidor de ingesta con secreto compartido', () => {
  let server: Server
  let queue: InMemoryMessageQueue

  beforeEach(async () => {
    queue = new InMemoryMessageQueue(() => 1_000)
    server = await listening(
      createIngestServer({
        port: 0,
        logger,
        publish: (body) => queue.publish(body),
        sharedSecret: 'secreto-de-prueba',
      }),
    )
  })

  afterEach(async () => {
    await close(server)
  })

  it('acepta con el secreto correcto', async () => {
    const response = await post(server, notification(), {
      headers: { 'x-ingest-secret': 'secreto-de-prueba' },
    })

    expect(response.status).toBe(202)
  })

  it.each([
    ['sin cabecera', undefined],
    ['secreto incorrecto', 'otro-secreto'],
    ['secreto de otra longitud', 'corto'],
    ['secreto vacio', ''],
  ])('responde 401: %s', async (_caso, secreto) => {
    const response = await post(server, notification(), {
      headers: secreto === undefined ? {} : { 'x-ingest-secret': secreto },
    })

    expect(response.status).toBe(401)
    expect(queue.pendingCount).toBe(0)
  })
})

/**
 * El recorrido que cierra el hueco: lo que Account publica entra por HTTP,
 * pasa por la cola y termina en un correo. Sin esta prueba, «la ingesta encola»
 * y «el consumidor envia» podrian ser ciertas por separado y el trayecto seguir
 * roto en la union.
 */
describe('Recorrido completo: ingesta HTTP -> cola -> correo', () => {
  it('entrega el correo con el codigo que entro por la ingesta', async () => {
    const nowMs = (): number => 1_000
    const queue = new InMemoryMessageQueue(nowMs)
    const emailSender = new FakeEmailSender()

    const useCase = new SendTransactionalEmail({
      emailSender,
      templateRenderer: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
      idempotencyStore: new InMemoryIdempotencyStore(nowMs),
      eventPublisher: new LoggingEventPublisher(logger),
      clock: { now: (): Date => new Date(1_000) },
      retryPolicy: RetryPolicy.create({ maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 }),
      idempotencyTtlMs: 600_000,
    })

    const consumer = new NotificationConsumer({ queue, useCase, logger, batchSize: 10 })
    const server = await listening(
      createIngestServer({ port: 0, logger, publish: (body) => queue.publish(body) }),
    )

    try {
      expect((await post(server, notification())).status).toBe(202)

      const summary = await consumer.processBatch()

      expect(summary.received).toBe(1)
      expect(emailSender.sent).toHaveLength(1)
      expect(emailSender.sent[0]!.to).toBe('jugador@nexus.test')
      // El codigo que entro por HTTP es el que sale en el correo.
      expect(emailSender.sent[0]!.text).toContain('424242')
    } finally {
      await close(server)
    }
  })

  /**
   * REGRESION. La ingesta NO debe reservar la clave de idempotencia: el caso de
   * uso reserva `idempotencyKey ?? notificationId` justo antes de enviar. Si la
   * ingesta tomara la misma reserva, el consumidor la encontraria ocupada,
   * resolveria `Duplicated` y descartaria el correo EN SILENCIO — con 202
   * devuelto y la cola vaciandose con normalidad.
   */
  it('no consume la reserva de idempotencia: el correo se envia de verdad', async () => {
    const nowMs = (): number => 1_000
    const queue = new InMemoryMessageQueue(nowMs)
    const emailSender = new FakeEmailSender()
    const idempotencyStore = new InMemoryIdempotencyStore(nowMs)

    const useCase = new SendTransactionalEmail({
      emailSender,
      templateRenderer: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
      idempotencyStore,
      eventPublisher: new LoggingEventPublisher(logger),
      clock: { now: (): Date => new Date(1_000) },
      retryPolicy: RetryPolicy.create({ maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 }),
      idempotencyTtlMs: 600_000,
    })

    const consumer = new NotificationConsumer({ queue, useCase, logger, batchSize: 10 })
    const server = await listening(
      createIngestServer({ port: 0, logger, publish: (body) => queue.publish(body) }),
    )

    try {
      await post(server, notification())
      await consumer.processBatch()

      expect(emailSender.sent).toHaveLength(1)

      // Control: la segunda vez SI debe suprimirse, para demostrar que la
      // idempotencia sigue viva y que el envio anterior no fue casualidad.
      await post(server, notification())
      await consumer.processBatch()

      expect(emailSender.sent).toHaveLength(1)
    } finally {
      await close(server)
    }
  })
})
