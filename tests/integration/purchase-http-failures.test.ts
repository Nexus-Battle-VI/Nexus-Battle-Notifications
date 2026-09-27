import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from '@jest/globals'
import {
  createPurchaseServer,
  PURCHASE_PATH,
} from '../../src/infrastructure/http/purchase-server.js'
import { SendPurchaseConfirmation } from '../../src/application/use-cases/SendPurchaseConfirmation.js'
import { InMemoryPurchaseInbox } from '../../src/adapters/idempotency/InMemoryPurchaseInbox.js'
import { InMemoryTemplateRenderer } from '../../src/adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../src/adapters/templates/default-templates.js'
import { signInternalRequest } from '../../src/adapters/identity/internal-signature.js'
import type { EmailSenderPort } from '../../src/application/ports/EmailSenderPort.js'
import type { PurchaseInboxPort } from '../../src/application/ports/PurchaseInboxPort.js'
import type { LogContext, Logger } from '../../src/infrastructure/observability/logger.js'

const secret = 'test-secret-not-for-production'
const recipient = 'player@example.com'
const body = {
  notificationId: '22222222-2222-4222-8222-222222222222',
  orderId: '33333333-3333-4333-8333-333333333333',
  recipient,
  currency: 'USD',
  total: 2500,
  items: [
    {
      productId: '11111111-1111-4111-8111-111111111111',
      name: 'Espada del dragón',
      quantity: 2,
      unitPrice: 1250,
    },
  ],
}

interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly context: LogContext | undefined
}

const capturingLogger = (): { logger: Logger; entries: LogEntry[] } => {
  const entries: LogEntry[] = []
  const at =
    (level: LogEntry['level']) =>
    (message: string, context?: LogContext): void => {
      entries.push({ level, message, context })
    }

  return {
    entries,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  }
}

/** Rechazo con la forma del SDK de AWS: nombre, codigo HTTP y la direccion en el mensaje. */
const sesRejection = (): Error =>
  Object.assign(
    new Error(
      `Email address is not verified. The following identities failed the check in region us-east-1: ${recipient}`,
    ),
    { name: 'MessageRejected', $metadata: { httpStatusCode: 400 } },
  )

describe('HTTP de confirmacion: fallos que no son «pendiente»', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve()
            })
          }),
      ),
    )
  })

  const start = async (
    inbox: PurchaseInboxPort,
    emailSender: EmailSenderPort,
    logger: Logger,
  ): Promise<string> => {
    const server = createPurchaseServer({
      port: 0,
      sharedSecret: secret,
      logger,
      useCase: new SendPurchaseConfirmation({
        inbox,
        emailSender,
        templates: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
      }),
    })
    servers.push(server)
    await once(server, 'listening')

    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  }

  const post = (url: string): Promise<Response> => {
    const timestamp = String(Date.now())

    return fetch(url + PURCHASE_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service': 'commerce',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': signInternalRequest(secret, {
          service: 'commerce',
          method: 'POST',
          path: PURCHASE_PATH,
          timestamp,
          body,
        }),
      },
      body: JSON.stringify(body),
    })
  }

  it('un rechazo del proveedor de correo se registra como error real, sin la direccion, y sigue siendo 503', async () => {
    const { logger, entries } = capturingLogger()
    const url = await start(
      new InMemoryPurchaseInbox(),
      { send: () => Promise.reject(sesRejection()) },
      logger,
    )

    const response = await post(url)

    // El contrato con Commerce no cambia: 503 y el mismo cuerpo.
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'purchase_pending' })

    // La causa real ya no queda escondida bajo el aviso de «pendiente».
    expect(entries.filter((e) => e.message === 'purchase_confirmation_pending')).toEqual([])
    expect(entries.filter((e) => e.level === 'error')).toEqual([
      {
        level: 'error',
        message: 'purchase_confirmation_failed',
        context: { errorName: 'MessageRejected', httpStatus: 400 },
      },
    ])

    // Ni la direccion ni el mensaje del proveedor llegan al registro.
    expect(JSON.stringify(entries)).not.toContain(recipient)
    expect(JSON.stringify(entries)).not.toContain('not verified')
  })

  it('una entrega realmente pendiente sigue siendo un aviso, no un error', async () => {
    const { logger, entries } = capturingLogger()
    const busy: PurchaseInboxPort = {
      claim: () => Promise.resolve({ status: 'BUSY' }),
      renew: () => Promise.resolve(true),
      markSent: () => Promise.resolve(true),
      release: () => Promise.resolve(),
    }
    const url = await start(busy, { send: () => Promise.reject(sesRejection()) }, logger)

    const response = await post(url)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'purchase_pending' })
    expect(entries).toEqual([
      { level: 'warn', message: 'purchase_confirmation_pending', context: {} },
    ])
  })
})
