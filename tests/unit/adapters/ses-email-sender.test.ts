import {
  AccountSuspendedException,
  MailFromDomainNotVerifiedException,
  MessageRejected,
  SendingPausedException,
  type SendEmailCommand,
  type SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2'

import { SesEmailSender } from '../../../src/adapters/email/SesEmailSender.js'
import { EmailDeliveryError } from '../../../src/application/ports/EmailSenderPort.js'

const email = {
  to: 'jugador@nexus.test',
  subject: 'Asunto',
  html: '<p>Hola</p>',
  text: 'Hola',
}

const meta = { $metadata: {} }

const senderWith = (
  send: (command: SendEmailCommand) => Promise<SendEmailCommandOutput>,
): SesEmailSender =>
  new SesEmailSender({
    client: { send },
    from: 'no-reply@simuladorupbbga.app',
  })

describe('SesEmailSender', () => {
  it('devuelve el identificador que asigna SES', async () => {
    const sender = senderWith(() => Promise.resolve({ MessageId: 'ses-1', ...meta }))

    await expect(sender.send(email)).resolves.toEqual({ providerMessageId: 'ses-1' })
  })

  it('envia el destinatario, el asunto y ambos cuerpos', async () => {
    let enviado: SendEmailCommand | null = null

    const sender = senderWith((command) => {
      enviado = command

      return Promise.resolve({ MessageId: 'ses-2', ...meta })
    })

    await sender.send(email)

    const input = enviado!.input

    expect(input.FromEmailAddress).toBe('no-reply@simuladorupbbga.app')
    expect(input.Destination?.ToAddresses).toEqual(['jugador@nexus.test'])
    expect(input.Content?.Simple?.Subject?.Data).toBe('Asunto')
    expect(input.Content?.Simple?.Body?.Html?.Data).toBe('<p>Hola</p>')
    expect(input.Content?.Simple?.Body?.Text?.Data).toBe('Hola')
  })

  /**
   * SES puede aceptar la peticion sin devolver identificador. No se puede
   * afirmar que el correo saliera, asi que se trata como fallo -reintentable-
   * en lugar de darlo por entregado.
   */
  it('falla si SES no devuelve identificador', async () => {
    const sender = senderWith(() => Promise.resolve({ ...meta }))

    const error = await sender.send(email).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect((error as EmailDeliveryError).retryable).toBe(true)
  })

  /**
   * Lo que NO debe reintentarse. `MessageRejected` es el caso del sandbox: un
   * destinatario sin verificar. Reintentarlo no lo arregla y gasta cuota.
   */
  it.each([
    [
      'MessageRejected (destinatario sin verificar)',
      new MessageRejected({ message: 'r', ...meta }),
    ],
    [
      'MailFromDomainNotVerified',
      new MailFromDomainNotVerifiedException({ message: 'd', ...meta }),
    ],
    ['AccountSuspended', new AccountSuspendedException({ message: 's', ...meta })],
    ['SendingPaused', new SendingPausedException({ message: 'p', ...meta })],
  ])('no reintenta ante %s', async (_caso, lanzado) => {
    const sender = senderWith(() => Promise.reject(lanzado))

    const error = await sender.send(email).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect((error as EmailDeliveryError).retryable).toBe(false)
  })

  /**
   * El control de los casos anteriores: un fallo cualquiera -red, limitacion de
   * tasa, 5xx- SI se reintenta. Sin este caso, "no reintenta" pasaria igual con
   * un adaptador que nunca reintentara nada.
   */
  it('reintenta ante un fallo transitorio', async () => {
    const sender = senderWith(() => Promise.reject(new Error('socket colgado')))

    const error = await sender.send(email).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect((error as EmailDeliveryError).retryable).toBe(true)
  })
})
