export interface OutboundEmail {
  readonly to: string
  readonly subject: string
  readonly html: string
  readonly text: string
}

export interface EmailDeliveryResult {
  readonly providerMessageId: string
}

/**
 * Puerto de salida hacia un proveedor de correo.
 *
 * Implementaciones previstas: FakeEmailSender (pruebas y desarrollo),
 * SmtpEmailSender (Mailpit local) y, cuando exista aprobacion, un adaptador SES.
 */
export interface EmailSenderPort {
  send(email: OutboundEmail): Promise<EmailDeliveryResult>
}

/**
 * Error que un adaptador de correo usa para informar al caso de uso si el
 * fallo admite reintento. Vive en la capa de aplicacion porque es parte del
 * contrato del puerto, no de la regla de negocio.
 */
export class EmailDeliveryError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'EmailDeliveryError'
    this.retryable = retryable
  }
}
