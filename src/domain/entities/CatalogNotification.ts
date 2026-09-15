import { randomUUID } from 'node:crypto'
import { DomainError } from '../errors/DomainError.js'
import type { CatalogChangeType } from './CatalogChangeType.js'

/**
 * A quién se dirige una notificación de catálogo.
 *
 * `GLOBAL` es para cambios que no dependen de posesión (creación de producto,
 * ajuste de tiraje, condición Premium: HU-38 no define un filtro de
 * destinatarios para ellos, así que se presentan a todos los jugadores).
 * `PLAYER` es para cambios que HU-38 sí dirige a quienes poseen el producto
 * (suspensión, reactivación).
 *
 * Una fila `GLOBAL` se persiste UNA sola vez, no una por jugador: el estado de
 * lectura por jugador vive aparte, en `GlobalNotificationReceipt`. Materializar
 * una fila por jugador exigiría conocer la base completa de cuentas, que este
 * servicio no tiene ni debe tener acceso a consultar.
 */
export const NotificationAudience = {
  Global: 'GLOBAL',
  Player: 'PLAYER',
} as const

export type NotificationAudience = (typeof NotificationAudience)[keyof typeof NotificationAudience]

export const ReadStatus = {
  Pending: 'PENDING',
  Read: 'READ',
} as const

export type ReadStatus = (typeof ReadStatus)[keyof typeof ReadStatus]

export interface CatalogNotificationSnapshot {
  readonly id: string
  readonly audience: NotificationAudience
  readonly playerId: string | null
  readonly changeType: CatalogChangeType
  readonly description: string
  readonly productId: string | null
  readonly productName: string | null
  readonly implementedAt: Date
  readonly readStatus: ReadStatus
  readonly readAt: Date | null
  readonly sourceEventId: string
  readonly sourceEventType: string
  readonly createdAt: Date
}

export interface CreateCatalogNotificationParams {
  readonly changeType: CatalogChangeType
  readonly description: string
  readonly productId?: string | null
  readonly productName?: string | null
  readonly implementedAt: Date
  readonly sourceEventId: string
  readonly sourceEventType: string
  /** Solo para audiencia PLAYER. Ausente o null construye una notificación GLOBAL. */
  readonly playerId?: string | null
  readonly now: Date
  readonly id?: string
}

/**
 * Notificación de catálogo dirigida a jugadores (HU-38).
 *
 * Deliberadamente NO es el mismo agregado que `Notification` (correo
 * transaccional, HU-04/HU-33.10): sus invariantes son distintas -esta no tiene
 * intentos de entrega ni política de reintentos de proveedor, y sí tiene
 * estado de lectura y consolidación-. Forzar el agregado de correo a
 * representar esto habría mezclado dos conceptos con reglas propias.
 */
export class CatalogNotification {
  readonly id: string
  readonly audience: NotificationAudience
  readonly playerId: string | null
  readonly changeType: CatalogChangeType
  readonly description: string
  readonly productId: string | null
  readonly productName: string | null
  readonly implementedAt: Date
  readonly sourceEventId: string
  readonly sourceEventType: string
  readonly createdAt: Date
  private status: ReadStatus
  private readAtValue: Date | null

  private constructor(params: {
    id: string
    audience: NotificationAudience
    playerId: string | null
    changeType: CatalogChangeType
    description: string
    productId: string | null
    productName: string | null
    implementedAt: Date
    sourceEventId: string
    sourceEventType: string
    createdAt: Date
    status: ReadStatus
    readAt: Date | null
  }) {
    this.id = params.id
    this.audience = params.audience
    this.playerId = params.playerId
    this.changeType = params.changeType
    this.description = params.description
    this.productId = params.productId
    this.productName = params.productName
    this.implementedAt = params.implementedAt
    this.sourceEventId = params.sourceEventId
    this.sourceEventType = params.sourceEventType
    this.createdAt = params.createdAt
    this.status = params.status
    this.readAtValue = params.readAt
  }

  static create(params: CreateCatalogNotificationParams): CatalogNotification {
    const description = params.description.trim()

    if (description.length === 0) {
      throw new DomainError('La descripción de la notificación es obligatoria.')
    }

    if (params.sourceEventId.trim().length === 0) {
      throw new DomainError('sourceEventId es obligatorio para trazabilidad.')
    }

    const playerId = params.playerId ?? null

    if (playerId !== null && playerId.trim().length === 0) {
      throw new DomainError('playerId no puede ser una cadena vacía.')
    }

    return new CatalogNotification({
      id: params.id ?? randomUUID(),
      audience: playerId === null ? NotificationAudience.Global : NotificationAudience.Player,
      playerId,
      changeType: params.changeType,
      description,
      productId: params.productId ?? null,
      productName: params.productName ?? null,
      implementedAt: params.implementedAt,
      sourceEventId: params.sourceEventId,
      sourceEventType: params.sourceEventType,
      createdAt: params.now,
      status: ReadStatus.Pending,
      readAt: null,
    })
  }

  static fromSnapshot(snapshot: CatalogNotificationSnapshot): CatalogNotification {
    return new CatalogNotification({
      id: snapshot.id,
      audience: snapshot.audience,
      playerId: snapshot.playerId,
      changeType: snapshot.changeType,
      description: snapshot.description,
      productId: snapshot.productId,
      productName: snapshot.productName,
      implementedAt: snapshot.implementedAt,
      sourceEventId: snapshot.sourceEventId,
      sourceEventType: snapshot.sourceEventType,
      createdAt: snapshot.createdAt,
      status: snapshot.readStatus,
      readAt: snapshot.readAt,
    })
  }

  get readStatus(): ReadStatus {
    return this.status
  }

  get readAt(): Date | null {
    return this.readAtValue
  }

  /**
   * PLAYER: marca la notificación propia como leída. No aplica a GLOBAL: su
   * estado de lectura es por jugador y vive en `GlobalNotificationReceipt`, no
   * en esta fila compartida.
   */
  markRead(at: Date): void {
    if (this.audience !== NotificationAudience.Player) {
      throw new DomainError(
        'Una notificación GLOBAL no tiene estado de lectura propio; usa GlobalNotificationReceipt.',
      )
    }

    if (this.status === ReadStatus.Read) {
      return
    }

    this.status = ReadStatus.Read
    this.readAtValue = at
  }

  toSnapshot(): CatalogNotificationSnapshot {
    return {
      id: this.id,
      audience: this.audience,
      playerId: this.playerId,
      changeType: this.changeType,
      description: this.description,
      productId: this.productId,
      productName: this.productName,
      implementedAt: this.implementedAt,
      readStatus: this.status,
      readAt: this.readAtValue,
      sourceEventId: this.sourceEventId,
      sourceEventType: this.sourceEventType,
      createdAt: this.createdAt,
    }
  }
}
