import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type ChangeMessageVisibilityCommandOutput,
  type DeleteMessageCommandOutput,
  type ReceiveMessageCommandOutput,
  type SendMessageCommandOutput,
} from '@aws-sdk/client-sqs'

import type { MessageQueuePort, QueueMessage } from '../../application/ports/MessageQueuePort.js'

export interface SqsTransport {
  send(
    command:
      | ReceiveMessageCommand
      | DeleteMessageCommand
      | ChangeMessageVisibilityCommand
      | SendMessageCommand,
  ): Promise<
    | ReceiveMessageCommandOutput
    | DeleteMessageCommandOutput
    | ChangeMessageVisibilityCommandOutput
    | SendMessageCommandOutput
  >
}

export interface SqsMessageQueueOptions {
  readonly client: SqsTransport
  readonly queueUrl: string
  readonly deadLetterQueueUrl?: string | null
  readonly waitTimeSeconds?: number
  readonly visibilityTimeout?: number
}

export class SqsMessageQueue implements MessageQueuePort {
  private readonly options: SqsMessageQueueOptions
  private readonly cachedBodies = new Map<string, string>()

  constructor(options: SqsMessageQueueOptions) {
    this.options = options
  }

  async receive(maxMessages: number): Promise<readonly QueueMessage[]> {
    const limit = Math.min(Math.max(1, maxMessages), 10)
    const command = new ReceiveMessageCommand({
      QueueUrl: this.options.queueUrl,
      MaxNumberOfMessages: limit,
      WaitTimeSeconds: this.options.waitTimeSeconds ?? 20,
      VisibilityTimeout: this.options.visibilityTimeout ?? 60,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    })

    const response = (await this.options.client.send(command)) as ReceiveMessageCommandOutput
    const messages = response.Messages ?? []

    return messages.map((m) => {
      const receiptHandle = m.ReceiptHandle ?? ''
      const body = m.Body ?? ''
      const receivedCount = parseInt(m.Attributes?.ApproximateReceiveCount ?? '1', 10) || 1

      if (receiptHandle) {
        this.cachedBodies.set(receiptHandle, body)
      }

      return {
        id: m.MessageId ?? '',
        body,
        receiptHandle,
        receivedCount,
      }
    })
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    const command = new DeleteMessageCommand({
      QueueUrl: this.options.queueUrl,
      ReceiptHandle: receiptHandle,
    })

    await this.options.client.send(command)
    this.cachedBodies.delete(receiptHandle)
  }

  async requeue(receiptHandle: string, delayMs: number): Promise<void> {
    const visibilityTimeout = Math.max(0, Math.ceil(delayMs / 1000))
    const command = new ChangeMessageVisibilityCommand({
      QueueUrl: this.options.queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: visibilityTimeout,
    })

    await this.options.client.send(command)
  }

  async deadLetter(receiptHandle: string, reason: string): Promise<void> {
    const body = this.cachedBodies.get(receiptHandle) ?? ''

    if (this.options.deadLetterQueueUrl) {
      // Reenvío controlado a DLQ
      const sendCommand = new SendMessageCommand({
        QueueUrl: this.options.deadLetterQueueUrl,
        MessageBody: body,
        MessageAttributes: {
          DeadLetterReason: {
            DataType: 'String',
            StringValue: reason,
          },
        },
      })

      await this.options.client.send(sendCommand)

      // Eliminar el mensaje de la cola principal para evitar bucle
      await this.acknowledge(receiptHandle)
    } else {
      // Si no hay DLQ configurada explícitamente en el adaptador,
      // visibilidad 0 para que la política de redrive de SQS lo traslade a DLQ
      await this.requeue(receiptHandle, 0)
      this.cachedBodies.delete(receiptHandle)
    }
  }

  static createClient(region: string): SqsTransport {
    const client = new SQSClient({ region })
    return {
      send: (cmd) => client.send(cmd as never),
    }
  }
}
