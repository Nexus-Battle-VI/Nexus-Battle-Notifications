export interface BattleDropNotificationCommand {
  readonly battleId: string
  readonly defeatEventSeq: number
  readonly role: 'GAINED' | 'LOST'
  readonly recipientId: string
  readonly productInstanceId: string
  readonly productId: string
  readonly itemId: string
  readonly creditedAt: string
}

export class InvalidBattleDropNotificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidBattleDropNotificationError'
  }
}

export const parseBattleDropNotification = (body: unknown): BattleDropNotificationCommand => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidBattleDropNotificationError('El cuerpo debe ser un objeto.')
  }
  const source = body as Record<string, unknown>
  const read = (field: string): string => {
    const value = source[field]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidBattleDropNotificationError(`${field} es obligatorio.`)
    }
    return value
  }
  const role = read('role')
  const defeatEventSeq = source['defeatEventSeq']
  if (
    (role !== 'GAINED' && role !== 'LOST') ||
    typeof defeatEventSeq !== 'number' ||
    !Number.isSafeInteger(defeatEventSeq) ||
    defeatEventSeq < 1
  ) {
    throw new InvalidBattleDropNotificationError('role o defeatEventSeq inválido.')
  }
  const creditedAt = read('creditedAt')
  if (Number.isNaN(new Date(creditedAt).getTime())) {
    throw new InvalidBattleDropNotificationError('creditedAt inválido.')
  }
  return {
    battleId: read('battleId'),
    defeatEventSeq,
    role,
    recipientId: read('recipientId'),
    productInstanceId: read('productInstanceId'),
    productId: read('productId'),
    itemId: read('itemId'),
    creditedAt,
  }
}
