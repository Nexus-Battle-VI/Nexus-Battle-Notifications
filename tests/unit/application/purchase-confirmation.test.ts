import { describe, expect, it } from '@jest/globals'
import { SendPurchaseConfirmation } from '../../../src/application/use-cases/SendPurchaseConfirmation.js'
import { parsePurchaseConfirmation } from '../../../src/application/dto/PurchaseConfirmationCommand.js'
import { InMemoryPurchaseInbox } from '../../../src/adapters/idempotency/InMemoryPurchaseInbox.js'
import { FakeEmailSender } from '../../../src/adapters/email/FakeEmailSender.js'
import { InMemoryTemplateRenderer } from '../../../src/adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../../src/adapters/templates/default-templates.js'
import {
  PurchaseConflictError,
  PurchasePendingError,
} from '../../../src/application/ports/PurchaseInboxPort.js'

const command = {
  notificationId: '22222222-2222-4222-8222-222222222222',
  orderId: '33333333-3333-4333-8333-333333333333',
  recipient: 'player@example.com',
  currency: 'COP',
  total: 3050,
  items: [
    {
      productId: '11111111-1111-4111-8111-111111111111',
      name: 'Espada <b>rara</b>',
      quantity: 2,
      unitPrice: 1525,
    },
  ],
}
const templates = InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES)

describe('Confirmacion de compra', () => {
  it('envia destinatario, detalle y total exactos una sola vez; escapa HTML', async () => {
    const emailSender = new FakeEmailSender()
    const useCase = new SendPurchaseConfirmation({
      inbox: new InMemoryPurchaseInbox(),
      emailSender,
      templates,
    })
    const result = await useCase.execute(command)
    expect(await useCase.execute(command)).toEqual(result)
    expect(emailSender.sent).toHaveLength(1)
    const email = emailSender.sent[0]!
    expect(email.to).toBe(command.recipient)
    expect(email.html).toContain('&lt;b&gt;rara&lt;/b&gt;')
    expect(email.html).not.toContain('<b>rara</b>')
    expect(email.text).toContain('x2')
    expect(email.text).toContain('COP 30.50')
    expect(email.text).toContain(command.orderId)
    await expect(
      useCase.execute({ ...command, recipient: 'other@example.com' }),
    ).rejects.toBeInstanceOf(PurchaseConflictError)
  })

  it('rechaza datos incompletos, duplicados, moneda y totales inconsistentes antes de enviar', async () => {
    const sender = new FakeEmailSender()
    const useCase = new SendPurchaseConfirmation({
      inbox: new InMemoryPurchaseInbox(),
      emailSender: sender,
      templates,
    })
    for (const invalid of [
      null,
      [],
      { ...command, unknown: true },
      { ...command, total: 1 },
      { ...command, currency: 'GOLD' },
      { ...command, recipient: 'invalid' },
      { ...command, notificationId: 'legacy' },
      { ...command, items: [] },
      { ...command, items: [...command.items, ...command.items] },
      { ...command, items: [{ ...command.items[0], quantity: 0 }] },
      { ...command, items: [{ ...command.items[0], unitPrice: 1.2 }] },
      { ...command, items: [{ ...command.items[0], name: '' }] },
      { ...command, items: [{ ...command.items[0], productId: 'sku-old' }] },
    ])
      await expect(useCase.execute(invalid)).rejects.toThrow()
    expect(sender.sent).toHaveLength(0)
    expect(parsePurchaseConfirmation({ ...command, currency: 'USD' }).currency).toBe('USD')
    expect(parsePurchaseConfirmation({ ...command, currency: 'EUR' }).currency).toBe('EUR')
  })

  it('un request concurrente no afirma SENT mientras el primero esta enviando', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let started!: () => void
    const sending = new Promise<void>((resolve) => {
      started = resolve
    })
    const useCase = new SendPurchaseConfirmation({
      inbox: new InMemoryPurchaseInbox(),
      templates,
      emailSender: {
        send: async (): Promise<{ providerMessageId: string }> => {
          started()
          await pending
          return { providerMessageId: 'test' }
        },
      },
    })
    const first = useCase.execute(command)
    await sending
    await expect(useCase.execute(command)).rejects.toBeInstanceOf(PurchasePendingError)
    finish()
    expect((await first).status).toBe('SENT')
  })

  it('un fallo de proveedor permite reintentar el mismo payload sin perderlo', async () => {
    let calls = 0
    const useCase = new SendPurchaseConfirmation({
      inbox: new InMemoryPurchaseInbox(),
      templates,
      emailSender: {
        send: (): Promise<{ providerMessageId: string }> => {
          calls += 1
          return calls === 1
            ? Promise.reject(new Error('temporal'))
            : Promise.resolve({ providerMessageId: 'sent' })
        },
      },
    })
    await expect(useCase.execute(command)).rejects.toThrow('temporal')
    expect((await useCase.execute(command)).status).toBe('SENT')
    expect((await useCase.execute(command)).status).toBe('SENT')
    expect(calls).toBe(2)
  })

  it('el lease vence y un token viejo no confirma ni libera la reserva nueva', async () => {
    let now = 0
    const inbox = new InMemoryPurchaseInbox(() => now)
    const first = await inbox.claim('n', 'o', 'f', 100)
    if (first.status !== 'CLAIMED') throw new Error('claim esperado')
    expect(await inbox.renew('n', 'incorrecto', 100)).toBe(false)
    expect(await inbox.markSent('n', 'incorrecto')).toBe(false)
    await inbox.release('n', 'incorrecto')
    expect((await inbox.claim('n', 'o', 'f', 100)).status).toBe('BUSY')
    expect(await inbox.renew('n', first.token, 100)).toBe(true)
    now = 101
    const next = await inbox.claim('n', 'o', 'f', 100)
    if (next.status !== 'CLAIMED') throw new Error('claim esperado')
    expect(await inbox.markSent('n', first.token)).toBe(false)
    await inbox.release('n', first.token)
    expect(await inbox.markSent('n', next.token)).toBe(true)
    await expect(inbox.claim('otra', 'o', 'f', 100)).rejects.toBeInstanceOf(PurchaseConflictError)
  })
})
