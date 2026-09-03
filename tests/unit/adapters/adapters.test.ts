import { jest } from '@jest/globals'

import { FakeEmailSender } from '../../../src/adapters/email/FakeEmailSender.js'
import { SmtpEmailSender, type SmtpTransport } from '../../../src/adapters/email/SmtpEmailSender.js'
import { InMemoryTemplateRenderer } from '../../../src/adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../../src/adapters/templates/default-templates.js'
import { InMemoryIdempotencyStore } from '../../../src/adapters/idempotency/InMemoryIdempotencyStore.js'
import { SystemClock } from '../../../src/adapters/clock/SystemClock.js'
import { LoggingEventPublisher } from '../../../src/adapters/events/LoggingEventPublisher.js'
import { createLogger } from '../../../src/infrastructure/observability/logger.js'
import { EmailDeliveryError } from '../../../src/application/ports/EmailSenderPort.js'
import { TemplateNotFoundError } from '../../../src/application/ports/TemplateRendererPort.js'
import { notificationSent } from '../../../src/domain/events/NotificationSent.js'

const email = {
  to: 'jugador@nexus.test',
  subject: 'Asunto',
  html: '<p>Hola</p>',
  text: 'Hola',
}

describe('FakeEmailSender', () => {
  it('retiene los mensajes y devuelve identificadores unicos', async () => {
    const sender = new FakeEmailSender()

    const first = await sender.send(email)
    const second = await sender.send(email)

    expect(first.providerMessageId).toBe('fake-1')
    expect(second.providerMessageId).toBe('fake-2')
    expect(sender.sent).toHaveLength(2)

    sender.clear()
    expect(sender.sent).toHaveLength(0)
  })
})

describe('SmtpEmailSender', () => {
  const buildTransport = (impl: SmtpTransport['sendMail']): SmtpTransport => ({ sendMail: impl })

  it('delega en el transporte y propaga el remitente configurado', async () => {
    const sendMail = jest.fn(() => Promise.resolve({ messageId: 'smtp-1' }))
    const sender = new SmtpEmailSender({
      transport: buildTransport(sendMail),
      from: 'no-reply@nexus.test',
    })

    const result = await sender.send(email)

    expect(result.providerMessageId).toBe('smtp-1')
    expect(sendMail).toHaveBeenCalledWith({
      from: 'no-reply@nexus.test',
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    })
  })

  it('clasifica un rechazo permanente 5xx como no reintentable', async () => {
    const failure = Object.assign(new Error('mailbox unavailable'), { responseCode: 550 })
    const sender = new SmtpEmailSender({
      transport: buildTransport(() => Promise.reject(failure)),
      from: 'no-reply@nexus.test',
    })

    await expect(sender.send(email)).rejects.toMatchObject({
      name: 'EmailDeliveryError',
      retryable: false,
    })
  })

  it('clasifica un 4xx como reintentable', async () => {
    const failure = Object.assign(new Error('try again later'), { responseCode: 421 })
    const sender = new SmtpEmailSender({
      transport: buildTransport(() => Promise.reject(failure)),
      from: 'no-reply@nexus.test',
    })

    await expect(sender.send(email)).rejects.toBeInstanceOf(EmailDeliveryError)
  })

  it('trata un fallo de red sin codigo como reintentable', async () => {
    const sender = new SmtpEmailSender({
      transport: buildTransport(() => Promise.reject(new Error('ECONNREFUSED'))),
      from: 'no-reply@nexus.test',
    })

    await expect(sender.send(email)).rejects.toMatchObject({ retryable: true })
  })

  it('describe un rechazo que no es Error', async () => {
    const sender = new SmtpEmailSender({
      // Se rechaza con un valor que no es Error para verificar que el adaptador
      // lo traduce a un EmailDeliveryError con mensaje propio.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      transport: buildTransport(() => Promise.reject('roto')),
      from: 'no-reply@nexus.test',
    })

    await expect(sender.send(email)).rejects.toMatchObject({
      message: 'Fallo del transporte SMTP.',
    })
  })
})

describe('InMemoryTemplateRenderer', () => {
  const renderer = InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES)

  it('interpola las variables declaradas', async () => {
    const rendered = await renderer.render('account-verification-code', {
      displayName: 'Ana',
      code: '123456',
      expiresInMinutes: 10,
    })

    expect(rendered.subject).toBe('Tu codigo de verificacion de Nexus Battles')
    expect(rendered.html).toContain('<strong>123456</strong>')
    expect(rendered.text).toBe(
      'Hola Ana, tu codigo de verificacion es 123456. Caduca en 10 minutos.',
    )
  })

  it('sustituye por cadena vacia una variable ausente', async () => {
    const rendered = await renderer.render('account-welcome', {})

    expect(rendered.text).toBe('Hola , tu cuenta fue creada correctamente.')
  })

  it('renderiza el codigo de recuperacion de contrasena', async () => {
    const rendered = await renderer.render('account-password-recovery-code', { code: '000000' })

    expect(rendered.subject).toBe('Restablece tu contraseña de Nexus Battles')
    expect(rendered.html).toContain('<strong>000000</strong>')
    expect(rendered.html).toContain('Equipo Nexus Battles')
    expect(rendered.text).toContain('000000')
    expect(rendered.text).toContain('Si no solicitaste este cambio')
  })

  it('renderiza la confirmacion de cambio de contrasena', async () => {
    const rendered = await renderer.render('account-password-reset-confirmation', {})

    expect(rendered.subject).toBe('Tu contraseña de Nexus Battles fue actualizada')
    expect(rendered.text).toContain('tu contraseña se actualizó correctamente.')
  })

  it('renderiza la notificacion de cierre de eliminacion de cuenta (HU-43.4)', async () => {
    const rendered = await renderer.render('account-deletion-closed', {})

    expect(rendered.subject).toBe('Tu solicitud de eliminación de cuenta ha finalizado')
    expect(rendered.text).toContain(
      'el proceso de eliminación de tu cuenta que solicitaste ha finalizado',
    )
    expect(rendered.html).toContain('Equipo Nexus Battles')
    // El cierre no debe afirmar mas de lo que el alcance vigente de HU-43
    // establece: nada sobre otros bounded contexts, retencion o base legal.
    expect(rendered.text).not.toMatch(/community|commerce|catalog|inventario|retenci[oó]n/i)
  })

  it('ignora cualquier variable enviada de mas en el cierre de eliminacion: la plantilla no declara marcadores', async () => {
    const rendered = await renderer.render('account-deletion-closed', {
      subject: 'sub:ana@nexus.test',
      accountId: 'acc-123',
      email: 'ana@nexus.test',
      jti: 'token-secreto',
    })

    expect(rendered.subject).toBe('Tu solicitud de eliminación de cuenta ha finalizado')
    expect(rendered.html).not.toMatch(/sub:ana|acc-123|token-secreto/)
    expect(rendered.text).not.toMatch(/sub:ana|acc-123|token-secreto/)
  })

  it('interpola tambien el asunto', async () => {
    const rendered = await renderer.render('commerce-order-confirmed', {
      displayName: 'Ana',
      orderId: 'ORD-9',
      total: '120.00',
    })

    expect(rendered.subject).toBe('Confirmacion de tu pedido ORD-9')
  })

  it('acepta espacios dentro del marcador', async () => {
    const custom = InMemoryTemplateRenderer.fromRecord({
      demo: { subject: '{{  nombre  }}', html: '', text: '' },
    })

    expect((await custom.render('demo', { nombre: 'Ana' })).subject).toBe('Ana')
  })

  it('informa si conoce una plantilla', () => {
    expect(renderer.has('account-welcome')).toBe(true)
    expect(renderer.has('account-password-recovery-code')).toBe(true)
    expect(renderer.has('account-password-reset-confirmation')).toBe(true)
    expect(renderer.has('account-deletion-closed')).toBe(true)
    expect(renderer.has('inexistente')).toBe(false)
  })

  it('rechaza una plantilla desconocida', async () => {
    await expect(renderer.render('inexistente', {})).rejects.toBeInstanceOf(TemplateNotFoundError)
  })
})

describe('InMemoryIdempotencyStore', () => {
  it('concede la primera reserva y rechaza la segunda', async () => {
    const store = new InMemoryIdempotencyStore(() => 1_000)

    expect(await store.reserve('k', 5_000)).toBe(true)
    expect(await store.reserve('k', 5_000)).toBe(false)
  })

  it('permite reservar de nuevo tras liberar', async () => {
    const store = new InMemoryIdempotencyStore(() => 1_000)

    await store.reserve('k', 5_000)
    await store.release('k')

    expect(await store.reserve('k', 5_000)).toBe(true)
  })

  it('permite reservar de nuevo cuando la reserva expira', async () => {
    let now = 1_000
    const store = new InMemoryIdempotencyStore(() => now)

    await store.reserve('k', 5_000)
    now = 6_001

    expect(await store.reserve('k', 5_000)).toBe(true)
  })

  it('confirma una clave existente sin afectar el conteo', async () => {
    const store = new InMemoryIdempotencyStore(() => 1_000)

    await store.reserve('k', 5_000)
    await store.confirm('k')
    await store.confirm('inexistente')

    expect(store.size).toBe(1)
  })

  it('purga unicamente las reservas vencidas', async () => {
    let now = 1_000
    const store = new InMemoryIdempotencyStore(() => now)

    await store.reserve('corta', 1_000)
    await store.reserve('larga', 100_000)
    now = 3_000

    expect(store.purgeExpired()).toBe(1)
    expect(store.size).toBe(1)
  })
})

describe('SystemClock', () => {
  it('devuelve una fecha valida', () => {
    const before = Date.now()
    const now = new SystemClock().now().getTime()

    expect(now).toBeGreaterThanOrEqual(before)
  })
})

describe('LoggingEventPublisher', () => {
  it('registra cada evento de dominio', async () => {
    const lines: string[] = []
    const logger = createLogger({
      level: 'info',
      service: 'notifications',
      version: '0.1.0',
      sink: (line) => lines.push(line),
    })

    await new LoggingEventPublisher(logger).publish([
      notificationSent({
        aggregateId: 'n-1',
        recipient: 'a@nexus.test',
        templateId: 'account-welcome',
        attempt: 1,
        occurredAt: new Date('2026-08-21T10:00:00.000Z'),
      }),
    ])

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      message: 'domain_event',
      event: 'notifications.notification.sent',
      aggregateId: 'n-1',
    })
  })
})
