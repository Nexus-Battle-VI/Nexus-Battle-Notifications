import type { MessageQueuePort, QueueMessage } from '../../application/ports/MessageQueuePort.js'

interface StoredMessage {
  readonly id: string
  readonly body: string
  receiptHandle: string
  receivedCount: number
  visibleAtMs: number
}

/**
 * Cola en memoria con semantica "al menos una vez", visibilidad diferida y cola
 * de mensajes fallidos.
 *
 * Es el adaptador por defecto del entorno local: permite ejecutar y verificar el
 * worker completo sin AWS ni broker. La adopcion de SQS queda sujeta a ADR-006.
 * El paso del tiempo se inyecta para que las pruebas sean deterministas.
 */
export class InMemoryMessageQueue implements MessageQueuePort {
  private readonly pending: StoredMessage[] = []
  private readonly inFlight = new Map<string, StoredMessage>()
  private readonly dlq: { message: StoredMessage; reason: string }[] = []
  private sequence = 0

  private readonly nowMs: () => number

  constructor(nowMs: () => number) {
    this.nowMs = nowMs
  }

  publish(body: string): string {
    this.sequence += 1
    const id = `msg-${String(this.sequence)}`

    this.pending.push({
      id,
      body,
      receiptHandle: '',
      receivedCount: 0,
      visibleAtMs: this.nowMs(),
    })

    return id
  }

  receive(maxMessages: number): Promise<readonly QueueMessage[]> {
    if (maxMessages < 1) {
      return Promise.resolve([])
    }

    const now = this.nowMs()
    const taken: QueueMessage[] = []

    for (let index = 0; index < this.pending.length && taken.length < maxMessages; index += 1) {
      const message = this.pending[index]

      if (message === undefined || message.visibleAtMs > now) {
        continue
      }

      this.pending.splice(index, 1)
      index -= 1

      message.receivedCount += 1
      this.sequence += 1
      message.receiptHandle = `rh-${String(this.sequence)}`
      this.inFlight.set(message.receiptHandle, message)

      taken.push({
        id: message.id,
        body: message.body,
        receiptHandle: message.receiptHandle,
        receivedCount: message.receivedCount,
      })
    }

    return Promise.resolve(taken)
  }

  acknowledge(receiptHandle: string): Promise<void> {
    this.inFlight.delete(receiptHandle)

    return Promise.resolve()
  }

  requeue(receiptHandle: string, delayMs: number): Promise<void> {
    const message = this.inFlight.get(receiptHandle)

    if (message === undefined) {
      return Promise.resolve()
    }

    this.inFlight.delete(receiptHandle)
    message.visibleAtMs = this.nowMs() + Math.max(0, delayMs)
    this.pending.push(message)

    return Promise.resolve()
  }

  deadLetter(receiptHandle: string, reason: string): Promise<void> {
    const message = this.inFlight.get(receiptHandle)

    if (message === undefined) {
      return Promise.resolve()
    }

    this.inFlight.delete(receiptHandle)
    this.dlq.push({ message, reason })

    return Promise.resolve()
  }

  get pendingCount(): number {
    return this.pending.length
  }

  get inFlightCount(): number {
    return this.inFlight.size
  }

  get deadLettered(): readonly { message: { id: string; body: string }; reason: string }[] {
    return this.dlq
  }
}
