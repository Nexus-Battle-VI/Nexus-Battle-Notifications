export interface SendTransactionalEmailCommand {
  readonly notificationId: string
  readonly recipient: string
  readonly templateId: string
  readonly variables: Readonly<Record<string, string | number | boolean>>
  /** Clave de deduplicacion. Si se omite se usa `notificationId`. */
  readonly idempotencyKey?: string
  /**
   * Numero de entrega del mensaje segun la cola, en base 1. Equivale a
   * `ApproximateReceiveCount` en SQS. Permite que la politica de reintentos
   * cuente los intentos reales y no solo los de la entrega actual.
   */
  readonly deliveryAttempt?: number
}

export const SendTransactionalEmailOutcome = {
  Sent: 'SENT',
  Duplicated: 'DUPLICATED',
  Retry: 'RETRY',
  Discarded: 'DISCARDED',
} as const

export type SendTransactionalEmailOutcome =
  (typeof SendTransactionalEmailOutcome)[keyof typeof SendTransactionalEmailOutcome]

export interface SendTransactionalEmailResult {
  readonly outcome: SendTransactionalEmailOutcome
  readonly notificationId: string
  readonly attempt: number
  readonly retryDelayMs: number | null
  readonly reason: string | null
}
