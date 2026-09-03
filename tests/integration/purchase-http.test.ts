import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { beforeAll, afterAll, describe, expect, it } from '@jest/globals'
import {
  createPurchaseServer,
  PURCHASE_PATH,
} from '../../src/infrastructure/http/purchase-server.js'
import { SendPurchaseConfirmation } from '../../src/application/use-cases/SendPurchaseConfirmation.js'
import { InMemoryPurchaseInbox } from '../../src/adapters/idempotency/InMemoryPurchaseInbox.js'
import { FakeEmailSender } from '../../src/adapters/email/FakeEmailSender.js'
import { InMemoryTemplateRenderer } from '../../src/adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../src/adapters/templates/default-templates.js'
import { createLogger } from '../../src/infrastructure/observability/logger.js'
import { signInternalRequest } from '../../src/adapters/identity/internal-signature.js'
import { loadConfig } from '../../src/infrastructure/config/env.js'

const secret = 'test-secret-not-for-production'
const body = {
  notificationId: '22222222-2222-4222-8222-222222222222',
  orderId: '33333333-3333-4333-8333-333333333333',
  recipient: 'player@example.com',
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

describe('HTTP de confirmacion firmado', () => {
  let server: Server
  let url: string
  const sender = new FakeEmailSender()
  beforeAll(async () => {
    server = createPurchaseServer({
      port: 0,
      sharedSecret: secret,
      logger: createLogger({ level: 'error', service: 'test', version: 'test' }),
      useCase: new SendPurchaseConfirmation({
        inbox: new InMemoryPurchaseInbox(),
        emailSender: sender,
        templates: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
      }),
    })
    await once(server, 'listening')
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })
  const post = (
    payload: unknown = body,
    service = 'commerce',
    timestamp = String(Date.now()),
  ): Promise<Response> =>
    fetch(url + PURCHASE_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service': service,
        'x-internal-timestamp': timestamp,
        'x-internal-signature': signInternalRequest(secret, {
          service,
          method: 'POST',
          path: PURCHASE_PATH,
          timestamp,
          body: payload,
        }),
      },
      body: JSON.stringify(payload),
    })

  it('solo acepta identidad interna y firma vigentes', async () => {
    expect(
      (await fetch(url + PURCHASE_PATH, { method: 'POST', body: JSON.stringify(body) })).status,
    ).toBe(401)
    expect((await post(body, 'web')).status).toBe(401)
    expect((await post(body, 'commerce', '0')).status).toBe(401)
    expect(sender.sent).toHaveLength(0)
  })
  it('entrega y responde SENT; replay no envia otra vez', async () => {
    const first = await post()
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ notificationId: body.notificationId, status: 'SENT' })
    expect((await post()).status).toBe(200)
    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]?.text).toContain('dragón')
    expect((await post({ ...body, recipient: 'other@example.com' })).status).toBe(409)
  })
  it('valida total y forma; limita el cuerpo y no expone otras rutas', async () => {
    expect((await post({ ...body, total: 1 })).status).toBe(400)
    expect((await fetch(url + '/wrong')).status).toBe(404)
    expect((await fetch(url + PURCHASE_PATH)).status).toBe(405)
    expect((await fetch(url + PURCHASE_PATH, { method: 'POST', body: '{' })).status).toBe(400)
    expect(
      (await fetch(url + PURCHASE_PATH, { method: 'POST', body: 'x'.repeat(131073) })).status,
    ).toBe(413)
  })
})

describe('Configuracion de compras', () => {
  it('memory es explicito y solo no productivo; exige secreto y datastore', () => {
    expect(loadConfig({}).purchase).toBeNull()
    expect(() => loadConfig({ PURCHASE_HTTP_ENABLED: 'true' })).toThrow('SECRET')
    const env = { PURCHASE_HTTP_ENABLED: 'true', INTERNAL_SERVICE_AUTH_SECRET: secret }
    expect(() => loadConfig(env)).toThrow('MONGO_URL')
    expect(loadConfig({ ...env, PURCHASE_INBOX_DRIVER: 'memory' }).purchase?.inboxDriver).toBe(
      'memory',
    )
    expect(() =>
      loadConfig({ ...env, NODE_ENV: 'production', PURCHASE_INBOX_DRIVER: 'memory' }),
    ).toThrow('produccion')
    expect(() =>
      loadConfig({ ...env, MONGO_URL: 'mongodb://localhost:27017', PURCHASE_HTTP_PORT: '3001' }),
    ).toThrow('puertos')
    expect(
      loadConfig({ ...env, MONGO_URL: 'mongodb://localhost:27017' }).purchase?.databaseName,
    ).toBe('notifications')
  })
})
