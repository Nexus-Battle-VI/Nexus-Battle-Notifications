import { jest } from '@jest/globals'
import {
  ReceiveMessageCommand,
  type DeleteMessageCommandOutput,
  type ReceiveMessageCommandOutput,
  type ChangeMessageVisibilityCommandOutput,
  type SendMessageCommandOutput,
} from '@aws-sdk/client-sqs'
import {
  SqsMessageQueue,
  type SqsTransport,
} from '../../../src/adapters/messaging/SqsMessageQueue.js'

const meta = { $metadata: {} }

describe('SqsMessageQueue', () => {
  const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue'
  const dlqUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/test-dlq'

  it('recibe mensajes traduciendo atributos y ApproximateReceiveCount', async () => {
    const mockSend = jest.fn<SqsTransport['send']>().mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        const output: ReceiveMessageCommandOutput = {
          ...meta,
          Messages: [
            {
              MessageId: 'sqs-msg-1',
              Body: '{"test":true}',
              ReceiptHandle: 'receipt-1',
              Attributes: {
                ApproximateReceiveCount: '3',
              },
            },
          ],
        }
        return Promise.resolve(output)
      }
      const empty: ReceiveMessageCommandOutput = { ...meta, Messages: [] }
      return Promise.resolve(empty)
    })

    const queue = new SqsMessageQueue({
      client: { send: mockSend },
      queueUrl,
      waitTimeSeconds: 20,
      visibilityTimeout: 60,
    })

    const messages = await queue.receive(5)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({
      id: 'sqs-msg-1',
      body: '{"test":true}',
      receiptHandle: 'receipt-1',
      receivedCount: 3,
    })
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 60,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      }),
    )
  })

  it('confirma el mensaje llamando a DeleteMessageCommand', async () => {
    const deleteOutput: DeleteMessageCommandOutput = { ...meta }
    const mockSend = jest.fn<SqsTransport['send']>().mockResolvedValue(deleteOutput)
    const queue = new SqsMessageQueue({
      client: { send: mockSend },
      queueUrl,
    })

    await queue.acknowledge('receipt-handle-abc')

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          QueueUrl: queueUrl,
          ReceiptHandle: 'receipt-handle-abc',
        }),
      }),
    )
  })

  it('reencola modificando la visibilidad del mensaje en segundos', async () => {
    const changeOutput: ChangeMessageVisibilityCommandOutput = { ...meta }
    const mockSend = jest.fn<SqsTransport['send']>().mockResolvedValue(changeOutput)
    const queue = new SqsMessageQueue({
      client: { send: mockSend },
      queueUrl,
    })

    await queue.requeue('receipt-handle-abc', 5_000)

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          QueueUrl: queueUrl,
          ReceiptHandle: 'receipt-handle-abc',
          VisibilityTimeout: 5,
        }),
      }),
    )
  })

  it('mueve a DLQ enviando mensaje a la cola de fallidos y borrando de la cola origen', async () => {
    const mockSend = jest.fn<SqsTransport['send']>().mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        const receiveOutput: ReceiveMessageCommandOutput = {
          ...meta,
          Messages: [
            {
              MessageId: 'sqs-msg-2',
              Body: '{"poison":true}',
              ReceiptHandle: 'receipt-2',
            },
          ],
        }
        return Promise.resolve(receiveOutput)
      }
      const sendOutput: SendMessageCommandOutput = { ...meta, MessageId: 'dlq-1' }
      return Promise.resolve(sendOutput)
    })

    const queue = new SqsMessageQueue({
      client: { send: mockSend },
      queueUrl,
      deadLetterQueueUrl: dlqUrl,
    })

    await queue.receive(1)
    await queue.deadLetter('receipt-2', 'Version desconocida')

    // Debe haber enviado a DLQ
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          QueueUrl: dlqUrl,
          MessageBody: '{"poison":true}',
          MessageAttributes: expect.objectContaining({
            DeadLetterReason: expect.objectContaining({
              StringValue: 'Version desconocida',
            }),
          }),
        }),
      }),
    )

    // Y debe haber borrado de la cola principal
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          QueueUrl: queueUrl,
          ReceiptHandle: 'receipt-2',
        }),
      }),
    )
  })

  it('crea el cliente real de SQS en la region indicada', () => {
    const transport = SqsMessageQueue.createClient('us-east-1')
    expect(transport).toBeDefined()
    expect(typeof transport.send).toBe('function')
  })
})
