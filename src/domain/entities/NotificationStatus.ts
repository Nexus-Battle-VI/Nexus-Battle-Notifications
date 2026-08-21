/**
 * Estados posibles de una notificacion.
 *
 * Se modela como objeto constante y union de tipos en lugar de `enum` porque
 * el proyecto compila con `erasableSyntaxOnly`: la sintaxis debe poder
 * eliminarse sin generar codigo, de modo que Node 24 pueda ejecutar los
 * fuentes TypeScript directamente en desarrollo.
 */
export const NotificationStatus = {
  Pending: 'PENDING',
  Sent: 'SENT',
  Failed: 'FAILED',
  Discarded: 'DISCARDED',
} as const

export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus]
