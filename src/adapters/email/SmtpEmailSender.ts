import type {
  EmailDeliveryResult,
  EmailSenderPort,
  OutboundEmail,
} from '../../application/ports/EmailSenderPort.js'
import { EmailDeliveryError } from '../../application/ports/EmailSenderPort.js'

/**
 * Contrato minimo que necesita el adaptador de un transporte SMTP.
 * Se declara aqui para no acoplar el adaptador a la superficie completa de
 * nodemailer y para poder verificarlo sin levantar un servidor.
 */
export interface SmtpTransport {
  sendMail(options: {
    from: string
    to: string
    subject: string
    html: string
    text: string
  }): Promise<{ messageId: string }>
}

export interface SmtpEmailSenderOptions {
  readonly transport: SmtpTransport
  readonly from: string
}

/**
 * Adaptador SMTP. En desarrollo apunta a Mailpit en el host de la demo; en
 * produccion apuntaria al proveedor aprobado. La eleccion del proveedor real
 * permanece sujeta a ADR-004 y a la aprobacion de costos.
 */
export class SmtpEmailSender implements EmailSenderPort {
  private readonly options: SmtpEmailSenderOptions

  constructor(options: SmtpEmailSenderOptions) {
    this.options = options
  }

  async send(email: OutboundEmail): Promise<EmailDeliveryResult> {
    try {
      const result = await this.options.transport.sendMail({
        from: this.options.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      })

      return { providerMessageId: result.messageId }
    } catch (error: unknown) {
      throw new EmailDeliveryError(
        error instanceof Error ? error.message : 'Fallo del transporte SMTP.',
        SmtpEmailSender.isRetryable(error),
      )
    }
  }

  /**
   * Los codigos SMTP 5xx son permanentes (destinatario invalido, rechazo del
   * servidor) y no deben reintentarse. Los 4xx y los fallos de red si.
   */
  private static isRetryable(error: unknown): boolean {
    const code = (error as { responseCode?: unknown } | null)?.responseCode

    if (typeof code === 'number') {
      return code < 500
    }

    return true
  }
}
