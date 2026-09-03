import { DomainError } from '../../domain/errors/DomainError.js'
import { EmailAddress } from '../../domain/value-objects/EmailAddress.js'

export interface PurchaseItem {
  readonly productId: string
  readonly name: string
  readonly quantity: number
  readonly unitPrice: number
}

export interface PurchaseConfirmationCommand {
  readonly notificationId: string
  readonly orderId: string
  readonly recipient: string
  readonly items: readonly PurchaseItem[]
  readonly currency: 'COP' | 'USD' | 'EUR'
  readonly total: number
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('Se requiere un objeto.')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key)))
    throw new DomainError('Campos no declarados en el contrato.')
  return record
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500)
    throw new DomainError('Texto obligatorio o demasiado largo.')
  return value.trim()
}
const identifier = (value: unknown): string => {
  const raw = text(value)
  if (!uuid.test(raw)) throw new DomainError('Se requiere un UUID.')
  return raw.toLowerCase()
}
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new DomainError('Importe o cantidad invalido.')
  return value
}

export const parsePurchaseConfirmation = (input: unknown): PurchaseConfirmationCommand => {
  const source = object(input, [
    'notificationId',
    'orderId',
    'recipient',
    'items',
    'currency',
    'total',
  ])
  if (
    !Array.isArray(source['items']) ||
    source['items'].length === 0 ||
    source['items'].length > 200
  )
    throw new DomainError('La compra requiere entre 1 y 200 productos.')
  const seen = new Set<string>()
  const items = source['items']
    .map((raw): PurchaseItem => {
      const item = object(raw, ['productId', 'name', 'quantity', 'unitPrice'])
      const productId = identifier(item['productId'])
      if (seen.has(productId)) throw new DomainError('El producto esta repetido.')
      seen.add(productId)
      return {
        productId,
        name: text(item['name']),
        quantity: integer(item['quantity'], 1, 9999),
        unitPrice: integer(item['unitPrice'], 0),
      }
    })
    .sort((a, b) => a.productId.localeCompare(b.productId))
  const currency = source['currency']
  if (currency !== 'COP' && currency !== 'USD' && currency !== 'EUR')
    throw new DomainError('Moneda no soportada.')
  const total = integer(source['total'], 1)
  const calculated = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  if (!Number.isSafeInteger(calculated) || total !== calculated)
    throw new DomainError('El total no concilia con los productos.')
  return {
    notificationId: identifier(source['notificationId']),
    orderId: identifier(source['orderId']),
    recipient: EmailAddress.create(text(source['recipient'])).value,
    items,
    currency,
    total,
  }
}
