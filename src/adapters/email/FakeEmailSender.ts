import type {
  EmailDeliveryResult,
  EmailSenderPort,
  OutboundEmail,
} from '../../application/ports/EmailSenderPort.js'

/**
 * Adaptador de correo para desarrollo local y pruebas.
 *
 * No es una prueba falsa: es una implementacion real del puerto que retiene los
 * mensajes en memoria y permite inspeccionarlos. Es el adaptador por defecto
 * mientras no exista aprobacion para un proveedor real.
 */
export class FakeEmailSender implements EmailSenderPort {
  private readonly outbox: OutboundEmail[] = []
  private counter = 0

  send(email: OutboundEmail): Promise<EmailDeliveryResult> {
    this.outbox.push(email)
    this.counter += 1

    return Promise.resolve({ providerMessageId: `fake-${String(this.counter)}` })
  }

  get sent(): readonly OutboundEmail[] {
    return this.outbox
  }

  clear(): void {
    this.outbox.length = 0
  }
}
