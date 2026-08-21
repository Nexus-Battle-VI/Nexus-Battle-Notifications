import type { SendTransactionalEmailCommand } from '../../application/dto/SendTransactionalEmailCommand.js'

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMessageError'
  }
}

type Primitive = string | number | boolean

const isPrimitive = (value: unknown): value is Primitive =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const readString = (source: Record<string, unknown>, field: string): string => {
  const value = source[field]

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidMessageError(`El campo "${field}" es obligatorio y debe ser texto.`)
  }

  return value
}

const readVariables = (source: Record<string, unknown>): Record<string, Primitive> => {
  const raw = source['variables']

  if (raw === undefined || raw === null) {
    return {}
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidMessageError('El campo "variables" debe ser un objeto.')
  }

  const result: Record<string, Primitive> = {}

  for (const [key, value] of Object.entries(raw)) {
    if (!isPrimitive(value)) {
      throw new InvalidMessageError(
        `La variable "${key}" debe ser texto, numero o booleano; no se admiten objetos anidados.`,
      )
    }

    result[key] = value
  }

  return result
}

/**
 * Traduce el cuerpo crudo de un mensaje de cola al comando de aplicacion.
 *
 * Es un adaptador de entrada: valida la forma del mensaje antes de que llegue
 * al caso de uso. Un mensaje malformado nunca es reintentable.
 */
export const parseNotificationMessage = (body: string): SendTransactionalEmailCommand => {
  let parsed: unknown

  try {
    parsed = JSON.parse(body)
  } catch {
    throw new InvalidMessageError('El cuerpo del mensaje no es JSON valido.')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidMessageError('El cuerpo del mensaje debe ser un objeto JSON.')
  }

  const source = parsed as Record<string, unknown>
  const idempotencyKey = source['idempotencyKey']

  const command: SendTransactionalEmailCommand = {
    notificationId: readString(source, 'notificationId'),
    recipient: readString(source, 'recipient'),
    templateId: readString(source, 'templateId'),
    variables: readVariables(source),
    ...(typeof idempotencyKey === 'string' && idempotencyKey.trim().length > 0
      ? { idempotencyKey }
      : {}),
  }

  return command
}
