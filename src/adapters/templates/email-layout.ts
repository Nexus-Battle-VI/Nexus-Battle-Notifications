/**
 * Armazon visual comun de los correos (EN-031).
 *
 * Se escribe con tablas y estilos en linea porque es lo unico que respetan
 * los clientes de correo (Gmail descarta `<style>` en muchos casos y Outlook
 * no entiende `flex` ni `grid`). Ancho maximo de 600 px.
 *
 * Las imagenes se ALOJAN en Web (`public/assets/email/`) y se cargan desde el
 * dominio publico: la politica de IAM solo concede `ses:SendEmail`, asi que no
 * hay adjuntos en linea. Ninguna parte del mensaje depende de que las
 * imagenes carguen: todas llevan `alt` y el texto se entiende sin ellas.
 *
 * El layout devuelve una PLANTILLA: los marcadores `{{clave}}` siguen ahi y
 * los sustituye `InMemoryTemplateRenderer`, que escapa cada valor.
 */

/** Dominio publico de Web. Estable (ver CLAUDE.md, "Donde mirar el estado real"). */
export const PUBLIC_WEB_URL = 'https://nexus.simuladorupbbga.app'

const ASSETS = `${PUBLIC_WEB_URL}/assets/email`

/** Iconos publicados en `public/assets/email/icon-<nombre>.png` (Web). */
export type EmailIcon =
  | 'user'
  | 'mail'
  | 'lock'
  | 'key'
  | 'shield'
  | 'check'
  | 'alert'
  | 'catalog'
  | 'auction'
  | 'loot'
  | 'credits'
  | 'sanction'
  | 'confirmed'

export interface EmailAction {
  readonly label: string
  /** Ruta de Web, con barra inicial (`/login`). */
  readonly path: string
}

export interface EmailLayoutInput {
  /** Texto que el cliente muestra junto al asunto, antes de abrir el correo. */
  readonly preheader: string
  readonly icon: EmailIcon
  /** Descripcion del icono para lectores de pantalla y correos sin imagenes. */
  readonly iconAlt: string
  readonly title: string
  /** Fragmento HTML del cuerpo (parrafos, `emailCode`, `emailFacts`...). */
  readonly body: string
  readonly action?: EmailAction
  /** Cierre propio del correo; por defecto, la firma del equipo. */
  readonly signature?: string
}

export interface EmailTextInput {
  readonly title: string
  /** Parrafos del cuerpo; se separan con una linea en blanco. */
  readonly paragraphs: readonly string[]
  readonly action?: EmailAction
  readonly signature?: string
}

const COLORS = {
  page: '#efe6d4',
  card: '#fffaf0',
  border: '#d9c9a3',
  ink: '#2a2236',
  muted: '#5d5368',
  accent: '#8a5a12',
  button: '#3b2a5c',
  buttonText: '#fbe9b7',
  buttonBorder: '#b8862b',
  codeBackground: '#2a2236',
  codeText: '#f5d27a',
  headerFallback: '#2a2236',
} as const

const FONT_BODY = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const FONT_TITLE = "Georgia, 'Times New Roman', serif"

const DEFAULT_SIGNATURE = 'Equipo Nexus Battles VI'

const NO_REPLY_NOTICE =
  'Este buzón no recibe respuestas. Para cualquier gestión, entra a Nexus Battles VI.'

/** Parrafo del cuerpo con la tipografia y el color del armazon. */
export const emailParagraph = (content: string): string =>
  `<p style="margin:0 0 16px;font-family:${FONT_BODY};font-size:16px;line-height:24px;color:${COLORS.ink};">${content}</p>`

/** Nota secundaria (avisos de seguridad, aclaraciones). */
export const emailNote = (content: string): string =>
  `<p style="margin:0 0 16px;font-family:${FONT_BODY};font-size:14px;line-height:21px;color:${COLORS.muted};">${content}</p>`

/** Codigo de un solo uso, destacado y facil de copiar. */
export const emailCode = (placeholder: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;">` +
  `<tr><td style="background:${COLORS.codeBackground};border:2px solid ${COLORS.buttonBorder};border-radius:8px;padding:14px 28px;font-family:Consolas,'Courier New',monospace;font-size:30px;line-height:36px;letter-spacing:8px;font-weight:bold;color:${COLORS.codeText};text-align:center;">${placeholder}</td></tr>` +
  `</table>`

/** Lista de datos «etiqueta: valor» (fechas de una sancion, total de un pedido). */
export const emailFacts = (facts: readonly (readonly [label: string, value: string])[]): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-top:1px solid ${COLORS.border};">` +
  facts
    .map(
      ([label, value]) =>
        `<tr>` +
        `<td style="padding:10px 12px 10px 0;border-bottom:1px solid ${COLORS.border};font-family:${FONT_BODY};font-size:14px;line-height:20px;color:${COLORS.muted};width:42%;vertical-align:top;">${label}</td>` +
        `<td style="padding:10px 0;border-bottom:1px solid ${COLORS.border};font-family:${FONT_BODY};font-size:15px;line-height:20px;color:${COLORS.ink};font-weight:bold;vertical-align:top;">${value}</td>` +
        `</tr>`,
    )
    .join('') +
  `</table>`

const actionButton = (action: EmailAction): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 8px;">` +
  `<tr><td style="background:${COLORS.button};border:2px solid ${COLORS.buttonBorder};border-radius:8px;">` +
  `<a href="${PUBLIC_WEB_URL}${action.path}" style="display:inline-block;padding:12px 28px;font-family:${FONT_TITLE};font-size:16px;font-weight:bold;letter-spacing:1px;color:${COLORS.buttonText};text-decoration:none;">${action.label}</a>` +
  `</td></tr></table>`

/** Correo HTML completo, con los marcadores del cuerpo sin sustituir. */
export const emailLayout = (input: EmailLayoutInput): string =>
  '<!DOCTYPE html>' +
  '<html lang="es">' +
  '<head>' +
  '<meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  // El arte es claro: se pide al cliente que no lo invierta.
  '<meta name="color-scheme" content="light">' +
  '<meta name="supported-color-schemes" content="light">' +
  `<title>${input.title}</title>` +
  '</head>' +
  `<body style="margin:0;padding:0;background:${COLORS.page};">` +
  // Texto de vista previa: oculto en el cuerpo, visible en la bandeja.
  `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${input.preheader}</div>` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.page};">` +
  '<tr><td align="center" style="padding:24px 12px;">' +
  `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;overflow:hidden;">` +
  // Cabecera: el arte va de FONDO y el logo encima. El cliente que no pinta
  // fondos (Outlook de escritorio) deja una banda oscura con el logo, que esta
  // pensado precisamente para fondo oscuro.
  `<tr><td align="center" background="${ASSETS}/header.png" bgcolor="${COLORS.headerFallback}" style="padding:30px 16px;background:${COLORS.headerFallback} url('${ASSETS}/header.png') center / cover no-repeat;">` +
  `<img src="${ASSETS}/logo.png" width="280" alt="Nexus Battles VI" style="display:block;margin:0 auto;width:280px;max-width:80%;height:auto;border:0;">` +
  '</td></tr>' +
  // Sello y titulo
  '<tr><td align="center" style="padding:28px 32px 8px;">' +
  `<img src="${ASSETS}/icon-${input.icon}.png" width="64" height="64" alt="${input.iconAlt}" style="display:block;margin:0 auto 12px;border:0;image-rendering:pixelated;">` +
  `<h1 style="margin:0;font-family:${FONT_TITLE};font-size:26px;line-height:32px;font-weight:bold;letter-spacing:1px;color:${COLORS.accent};">${input.title}</h1>` +
  '</td></tr>' +
  // Cuerpo
  `<tr><td style="padding:16px 32px 8px;">${input.body}</td></tr>` +
  (input.action === undefined
    ? ''
    : `<tr><td align="center" style="padding:0 32px 24px;">${actionButton(input.action)}</td></tr>`) +
  // Firma
  `<tr><td style="padding:8px 32px 28px;font-family:${FONT_TITLE};font-size:15px;line-height:22px;color:${COLORS.ink};">` +
  `<strong>${input.signature ?? DEFAULT_SIGNATURE}</strong>` +
  '</td></tr>' +
  '</table>' +
  // Pie
  `<p style="margin:16px 0 0;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${COLORS.muted};">${NO_REPLY_NOTICE}<br>` +
  `<a href="${PUBLIC_WEB_URL}" style="color:${COLORS.muted};">nexus.simuladorupbbga.app</a> · UPB-COMPANY</p>` +
  '</td></tr></table>' +
  '</body></html>'

/** Version de texto plano con la misma estructura. */
export const emailText = (input: EmailTextInput): string =>
  [
    'NEXUS BATTLES VI',
    '',
    input.title,
    '',
    input.paragraphs.join('\n\n'),
    ...(input.action === undefined
      ? []
      : ['', `${input.action.label}: ${PUBLIC_WEB_URL}${input.action.path}`]),
    '',
    input.signature ?? DEFAULT_SIGNATURE,
    '',
    '--',
    NO_REPLY_NOTICE,
  ].join('\n')
