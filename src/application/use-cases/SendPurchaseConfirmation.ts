import { createHash } from 'node:crypto'
import { parsePurchaseConfirmation } from '../dto/PurchaseConfirmationCommand.js'
import type { EmailSenderPort } from '../ports/EmailSenderPort.js'
import { PurchasePendingError, type PurchaseInboxPort } from '../ports/PurchaseInboxPort.js'
import type { TemplateRendererPort } from '../ports/TemplateRendererPort.js'

export interface PurchaseConfirmationDependencies {
  readonly inbox: PurchaseInboxPort
  readonly emailSender: EmailSenderPort
  readonly templates: TemplateRendererPort
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
const money = (amount: number, currency: string): string =>
  `${currency} ${String(Math.floor(amount / 100))}.${String(amount % 100).padStart(2, '0')}`

export class SendPurchaseConfirmation {
  private readonly deps: PurchaseConfirmationDependencies
  constructor(deps: PurchaseConfirmationDependencies) {
    this.deps = deps
  }

  async execute(input: unknown): Promise<{ notificationId: string; status: 'SENT' }> {
    const command = parsePurchaseConfirmation(input)
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex')
    const { notificationId, orderId } = command
    const claim = await this.deps.inbox.claim(notificationId, orderId, fingerprint, 90000)
    if (claim.status === 'SENT') return { notificationId, status: 'SENT' }
    if (claim.status !== 'CLAIMED') throw new PurchasePendingError()
    const token = claim.token
    const state = { leaseLost: false }
    const timer = setInterval(() => {
      void this.deps.inbox
        .renew(notificationId, token, 90000)
        .then((renewed) => {
          if (!renewed) state.leaseLost = true
        })
        .catch(() => {
          state.leaseLost = true
        })
    }, 15000)
    timer.unref()
    try {
      const details = command.items.map(
        (item) =>
          `${item.name} (${item.productId}) x${String(item.quantity)} — ${money(item.unitPrice, command.currency)}; subtotal ${money(item.unitPrice * item.quantity, command.currency)}`,
      )
      const rendered = await this.deps.templates.render('commerce-purchase-confirmed-v1', {
        orderId,
        total: money(command.total, command.currency),
        itemsHtml: details.map((line) => `<li>${escapeHtml(line)}</li>`).join(''),
        itemsText: details.join('\n'),
      })
      await this.deps.emailSender.send({ to: command.recipient, ...rendered })
      if (state.leaseLost || !(await this.deps.inbox.markSent(notificationId, token)))
        throw new PurchasePendingError()
      return { notificationId, status: 'SENT' }
    } catch (error: unknown) {
      await this.deps.inbox.release(notificationId, token)
      throw error
    } finally {
      clearInterval(timer)
    }
  }
}
