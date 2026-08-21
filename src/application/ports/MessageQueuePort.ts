export interface QueueMessage {
  readonly id: string
  readonly body: string
  readonly receiptHandle: string
  readonly receivedCount: number
}

/**
 * Puerto de cola de mensajes.
 *
 * Implementaciones previstas: InMemoryMessageQueue (desarrollo y pruebas) y un
 * adaptador SQS cuando ADR-006 pase a Accepted. El worker no depende de ninguna.
 */
export interface MessageQueuePort {
  receive(maxMessages: number): Promise<readonly QueueMessage[]>
  acknowledge(receiptHandle: string): Promise<void>
  requeue(receiptHandle: string, delayMs: number): Promise<void>
  deadLetter(receiptHandle: string, reason: string): Promise<void>
}
