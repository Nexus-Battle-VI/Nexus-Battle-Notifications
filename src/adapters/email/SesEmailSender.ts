import {
  AccountSuspendedException,
  MailFromDomainNotVerifiedException,
  MessageRejected,
  SendEmailCommand,
  SESv2Client,
  SendingPausedException,
  type SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2'

import type {
  EmailDeliveryResult,
  EmailSenderPort,
  OutboundEmail,
} from '../../application/ports/EmailSenderPort.js'
import { EmailDeliveryError } from '../../application/ports/EmailSenderPort.js'

/**
 * Superficie minima del cliente de SES que este adaptador necesita.
 *
 * Se declara aqui, igual que `SmtpTransport` para nodemailer, para poder
 * verificar la traduccion sin construir un cliente real ni firmar peticiones.
 */
export interface SesTransport {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>
}

export interface SesEmailSenderOptions {
  readonly client: SesTransport
  readonly from: string
}

/**
 * Adaptador de correo sobre Amazon SES (API v2).
 *
 * POR QUE LA API Y NO EL ENDPOINT SMTP DE SES
 *
 * SES ofrece las dos vias y `SmtpEmailSender` habria servido tal cual apuntado
 * a `email-smtp.<region>.amazonaws.com`. Se elige la API a proposito: el
 * endpoint SMTP exige un usuario de IAM con contrasena SMTP de larga vida, es
 * decir, UN SECRETO MAS que guardar, rotar y no filtrar. La API firma con las
 * credenciales del rol de instancia del nodo, asi que **no existe ningun
 * secreto que se pueda filtrar**. En un proyecto donde el estado de Terraform
 * guarda `user_data` entero y sin cifrar, esa diferencia importa.
 *
 * El cliente se construye solo con `region` y se apoya en la cadena de
 * credenciales por defecto del SDK (rol de instancia). Nunca se pasan claves de
 * acceso de forma explicita.
 *
 * SANDBOX: mientras la cuenta no tenga acceso de produccion, SES solo entrega a
 * direcciones verificadas. Un destinatario sin verificar se rechaza con
 * `MessageRejected`, que este adaptador clasifica como NO reintentable: repetir
 * el envio no lo va a arreglar y solo gastaria cuota.
 */
export class SesEmailSender implements EmailSenderPort {
  private readonly options: SesEmailSenderOptions

  constructor(options: SesEmailSenderOptions) {
    this.options = options
  }

  async send(email: OutboundEmail): Promise<EmailDeliveryResult> {
    let response: SendEmailCommandOutput

    try {
      response = await this.options.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.options.from,
          Destination: { ToAddresses: [email.to] },
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: email.html, Charset: 'UTF-8' },
                Text: { Data: email.text, Charset: 'UTF-8' },
              },
            },
          },
        }),
      )
    } catch (error: unknown) {
      throw new EmailDeliveryError(
        error instanceof Error ? error.message : 'Fallo del proveedor SES.',
        SesEmailSender.isRetryable(error),
      )
    }

    if (response.MessageId === undefined || response.MessageId === '') {
      // SES acepto la peticion pero no devolvio identificador: no se puede
      // afirmar que el correo saliera. Se trata como fallo reintentable en
      // lugar de dar por entregado algo que no se puede comprobar.
      throw new EmailDeliveryError('SES no devolvio identificador de mensaje.', true)
    }

    return { providerMessageId: response.MessageId }
  }

  /**
   * Que merece reintento y que no.
   *
   * NO reintentable -el reintento no cambia el resultado y consume cuota-:
   *   - `MessageRejected`: destinatario no verificado (sandbox), contenido
   *     rechazado o remitente invalido.
   *   - `MailFromDomainNotVerifiedException`: el dominio remitente no esta
   *     verificado. Es configuracion, no un fallo transitorio.
   *   - `AccountSuspendedException` / `SendingPausedException`: la cuenta no
   *     puede enviar. Insistir empeora la reputacion.
   *
   * SI reintentable: limitacion de tasa, errores 5xx del servicio y fallos de
   * red, que es el caso por defecto.
   */
  private static isRetryable(error: unknown): boolean {
    if (
      error instanceof MessageRejected ||
      error instanceof MailFromDomainNotVerifiedException ||
      error instanceof AccountSuspendedException ||
      error instanceof SendingPausedException
    ) {
      return false
    }

    return true
  }

  /** Cliente real de SES, firmado con el rol de instancia. */
  static createClient(region: string): SesTransport {
    const client = new SESv2Client({ region })

    return { send: (command) => client.send(command) }
  }
}
