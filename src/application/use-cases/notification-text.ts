/**
 * Piezas comunes de los textos que lee el jugador en sus notificaciones
 * (EN-031): cantidades y fechas en espanol de Colombia, nunca un ISO ni un
 * identificador interno. Los identificadores siguen en los campos
 * estructurados de la notificacion (`id`, `sourceEventId`, `productId`).
 */
const CREDITS = new Intl.NumberFormat('es-CO')

const DATE_TIME = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
})

export const formatCredits = (amount: number): string => `${CREDITS.format(amount)} créditos`

/** Fecha ISO legible; `null` si no es una fecha, para omitir la frase entera. */
export const formatNotificationDate = (iso: string): string | null => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : DATE_TIME.format(date)
}
