import type { RenderVariables } from '../../application/ports/TemplateRendererPort.js'
import {
  PUBLIC_WEB_URL,
  emailCode,
  emailFacts,
  emailLayout,
  emailNote,
  emailParagraph,
  emailText,
} from './email-layout.js'
import { escapeHtml, type TemplateDefinition } from './InMemoryTemplateRenderer.js'

/**
 * Catalogo de plantillas de correo.
 *
 * Los identificadores y las variables que declara cada plantilla forman parte
 * del contrato asincrono publicado en `docs/contracts` (Infrastructure).
 * Anadir o retirar una plantilla, o una variable, es un cambio de contrato.
 * El aspecto (EN-031) no lo es: lo pone `email-layout.ts`.
 */

const read = (variables: RenderVariables, key: string): string => {
  const value = variables[key]
  return value === undefined ? '' : String(value)
}

const DATE_FORMAT = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
})

/** Fecha ISO legible en espanol de Colombia; vacia si no es una fecha. */
export const formatEmailDate = (iso: string): string => {
  const date = new Date(iso)
  return iso === '' || Number.isNaN(date.getTime())
    ? ''
    : `${DATE_FORMAT.format(date)} (hora de Colombia)`
}

const SANCTION_LABELS: Readonly<Record<string, string>> = {
  WARNING: 'Advertencia',
  TEMPORARY_SUSPENSION: 'Suspensión temporal',
  PERMANENT_BAN: 'Expulsión permanente',
}

const APPEAL_DECISION_LABELS: Readonly<Record<string, string>> = {
  UPHELD: 'Se mantiene la sanción',
  OVERTURNED: 'Se revirtió la sanción',
}

const PRODUCT_TYPE_LABELS: Readonly<Record<string, string>> = {
  HEROE: 'Héroe',
  HABILIDAD: 'Habilidad',
  ARMA: 'Arma',
  ARMADURA: 'Armadura',
  ITEM: 'Ítem',
  EPICA: 'Épica',
}

/**
 * URL de imagen utilizable en un correo: absoluta `http(s)` o ruta de Web.
 * Cualquier otra cosa (un esquema `javascript:`, una ruta relativa al
 * cliente de correo) se descarta.
 */
const emailImageUrl = (raw: string): string | null => {
  if (/^https?:\/\/[^\s"'<>]+$/u.test(raw)) return raw
  if (/^\/[^/\s"'<>][^\s"'<>]*$/u.test(raw)) return `${PUBLIC_WEB_URL}${raw}`
  return null
}

export const DEFAULT_TEMPLATES: Readonly<Record<string, TemplateDefinition>> = {
  'account-sanction-applied': {
    subject: 'Nexus Battles VI — Se aplicó una sanción a tu cuenta',
    html: emailLayout({
      preheader: 'Revisa el detalle y, si no estás de acuerdo, apela dentro del plazo.',
      icon: 'sanction',
      iconAlt: 'Sanción',
      title: 'Sanción aplicada',
      body:
        emailParagraph('Hola {{displayName}},') +
        emailParagraph('Se aplicó una sanción a tu cuenta. Este es el detalle:') +
        emailFacts([
          ['Tipo', '{{sanctionTypeLabel}}'],
          ['Motivo', '{{reason}}'],
          ['Aplicada el', '{{appliedAtLabel}}'],
          ['Puedes apelar hasta', '{{appealDeadlineLabel}}'],
          ['Referencia', '{{sanctionId}}'],
        ]) +
        '{{expiryHtml}}' +
        emailParagraph(
          'Tienes <strong>{{appealWindowDays}} días</strong> para apelar. Si tu cuenta esta bloqueada, usa el mismo correo y contraseña en el enlace de abajo.',
        ),
      action: { label: 'Apelar esta sanción', path: '/appeal' },
      signature: 'Equipo Nexus Battles VI · Por una comunidad segura y justa',
    }),
    text: emailText({
      title: 'Sanción aplicada',
      paragraphs: [
        'Hola {{displayName}},',
        'Se aplicó una sanción a tu cuenta.',
        'Tipo: {{sanctionTypeLabel}}\n' +
          'Motivo: {{reason}}\n' +
          'Aplicada el: {{appliedAtLabel}}\n' +
          'Puedes apelar hasta: {{appealDeadlineLabel}}\n' +
          'Referencia: {{sanctionId}}{{expiryText}}',
        'Tienes {{appealWindowDays}} días para apelar. Si tu cuenta esta bloqueada, usa el mismo correo y contraseña en el enlace de abajo.',
      ],
      action: { label: 'Apelar esta sanción', path: '/appeal' },
      signature: 'Equipo Nexus Battles VI · Por una comunidad segura y justa',
    }),
    trustedHtml: ['expiryHtml'],
    derive: (variables) => {
      const type = read(variables, 'sanctionType')
      const expires = formatEmailDate(read(variables, 'expiresAt'))
      return {
        sanctionTypeLabel: SANCTION_LABELS[type] ?? type,
        appliedAtLabel: formatEmailDate(read(variables, 'appliedAt')),
        appealDeadlineLabel: formatEmailDate(read(variables, 'appealDeadline')),
        expiryHtml:
          expires === ''
            ? ''
            : emailParagraph(`La suspensión termina el <strong>${escapeHtml(expires)}</strong>.`),
        expiryText: expires === '' ? '' : `\nLa suspensión termina el: ${expires}`,
      }
    },
  },

  'account-appeal-received': {
    subject: 'Nexus Battles VI — Recibimos tu apelación',
    html: emailLayout({
      preheader: 'Tu apelación está en revisión. Te avisaremos cuando haya una decisión.',
      icon: 'check',
      iconAlt: 'Apelación recibida',
      title: 'Apelación recibida',
      body:
        emailParagraph('Hola {{displayName}},') +
        emailParagraph('Recibimos tu apelación sobre la siguiente sanción:') +
        emailFacts([
          ['Sanción apelada', '{{sanctionTypeLabel}}'],
          ['Referencia de la sanción', '{{sanctionId}}'],
          ['Referencia de tu apelación', '{{appealId}}'],
          ['Presentada el', '{{submittedAtLabel}}'],
          ['Fecha de referencia para la decisión', '{{decisionDueAtLabel}}'],
        ]) +
        emailNote(
          'Un panel de moderación revisará tu caso. Esta fecha es de referencia, no una garantía de respuesta exacta en ese día.',
        ),
      action: { label: 'Ver el estado de mi apelación', path: '/appeal' },
      signature: 'Equipo Nexus Battles VI · Por una comunidad segura y justa',
    }),
    text: emailText({
      title: 'Apelación recibida',
      paragraphs: [
        'Hola {{displayName}},',
        'Recibimos tu apelación sobre la siguiente sanción.',
        'Sanción apelada: {{sanctionTypeLabel}}\n' +
          'Referencia de la sanción: {{sanctionId}}\n' +
          'Referencia de tu apelación: {{appealId}}\n' +
          'Presentada el: {{submittedAtLabel}}\n' +
          'Fecha de referencia para la decisión: {{decisionDueAtLabel}}',
        'Un panel de moderación revisará tu caso. Esta fecha es de referencia, no una garantía de respuesta exacta en ese día.',
      ],
      action: { label: 'Ver el estado de mi apelación', path: '/appeal' },
      signature: 'Equipo Nexus Battles VI · Por una comunidad segura y justa',
    }),
    derive: (variables) => ({
      sanctionTypeLabel:
        SANCTION_LABELS[read(variables, 'sanctionType')] ?? read(variables, 'sanctionType'),
      submittedAtLabel: formatEmailDate(read(variables, 'submittedAt')),
      decisionDueAtLabel: formatEmailDate(read(variables, 'decisionDueAt')),
    }),
  },

  'account-appeal-resolved': {
    subject: 'Nexus Battles VI — Ya se decidió tu apelación',
    html: emailLayout({
      preheader: 'Hay una decisión sobre tu apelación.',
      icon: 'shield',
      iconAlt: 'Apelación resuelta',
      title: 'Apelación resuelta',
      body:
        emailParagraph('Hola {{displayName}},') +
        emailParagraph('Ya revisamos tu apelación. Este es el resultado:') +
        emailFacts([
          ['Sanción apelada', '{{sanctionTypeLabel}}'],
          ['Decisión', '{{decisionLabel}}'],
          ['Resuelta el', '{{resolvedAtLabel}}'],
          ['Referencia de tu apelación', '{{appealId}}'],
        ]) +
        emailParagraph('Motivo de la decisión: {{resolutionNotes}}'),
      action: { label: 'Ver el estado de mi apelación', path: '/appeal' },
      signature: 'Equipo Nexus Battles VI · Por una comunidad segura y justa',
    }),
    text: emailText({
      title: 'Apelación resuelta',
      paragraphs: [
        'Hola {{displayName}},',
        'Ya revisamos tu apelación. Este es el resultado.',
        'Sanción apelada: {{sanctionTypeLabel}}\n' +
          'Decisión: {{decisionLabel}}\n' +
          'Resuelta el: {{resolvedAtLabel}}\n' +
          'Referencia de tu apelación: {{appealId}}',
        'Motivo de la decisión: {{resolutionNotes}}',
      ],
      action: { label: 'Ver el estado de mi apelación', path: '/appeal' },
      signature: 'Equipo Nexus Battles VI · Por una comunidad segura y justa',
    }),
    derive: (variables) => ({
      sanctionTypeLabel:
        SANCTION_LABELS[read(variables, 'sanctionType')] ?? read(variables, 'sanctionType'),
      decisionLabel:
        APPEAL_DECISION_LABELS[read(variables, 'decision')] ?? read(variables, 'decision'),
      resolvedAtLabel: formatEmailDate(read(variables, 'resolvedAt')),
    }),
  },

  'commerce-purchase-confirmed-v1': {
    subject: 'Nexus Battles VI — Confirmación de compra {{orderId}}',
    html: emailLayout({
      preheader: 'Tu compra se completó. Total pagado: {{total}}.',
      icon: 'confirmed',
      iconAlt: 'Compra confirmada',
      title: 'Compra confirmada',
      body:
        emailParagraph('Tu compra simulada se completó correctamente. Esto es lo que adquiriste:') +
        '<ul style="margin:0 0 16px;padding-left:20px;font-family:\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:24px;color:#2a2236;">{{itemsHtml}}</ul>' +
        emailFacts([
          ['Pedido', '{{orderId}}'],
          ['Total pagado', '{{total}}'],
        ]),
      action: { label: 'Ver mis pedidos', path: '/orders' },
      signature: 'Gracias por jugar con nosotros · Equipo Nexus Battles VI',
    }),
    text: emailText({
      title: 'Compra confirmada',
      paragraphs: [
        'Tu compra simulada {{orderId}} se completó correctamente.',
        '{{itemsText}}',
        'Total pagado: {{total}}',
      ],
      action: { label: 'Ver mis pedidos', path: '/orders' },
      signature: 'Gracias por jugar con nosotros · Equipo Nexus Battles VI',
    }),
    // Llega escapada desde `SendPurchaseConfirmation`: cada linea en su `<li>`.
    trustedHtml: ['itemsHtml'],
  },

  'account-verification-code': {
    subject: 'Tu código de verificación de Nexus Battles VI',
    html: emailLayout({
      preheader: 'Tu código caduca en {{expiresInMinutes}} minutos.',
      icon: 'key',
      iconAlt: 'Código de verificación',
      title: 'Tu código de verificación',
      body:
        emailParagraph('Hola {{displayName}}, escribe este código para continuar:') +
        emailCode('{{code}}') +
        emailNote(
          'Caduca en {{expiresInMinutes}} minutos. Si no lo pediste tú, ignora este mensaje.',
        ),
    }),
    text: emailText({
      title: 'Tu código de verificación',
      paragraphs: [
        'Hola {{displayName}}, escribe este código para continuar: {{code}}',
        'Caduca en {{expiresInMinutes}} minutos. Si no lo pediste tú, ignora este mensaje.',
      ],
    }),
  },

  'account-welcome': {
    subject: 'Te damos la bienvenida a Nexus Battles VI',
    html: emailLayout({
      preheader: 'Tu cuenta está lista. Elige tu héroe y entra a la batalla.',
      icon: 'user',
      iconAlt: 'Cuenta creada',
      title: '¡Te damos la bienvenida, {{displayName}}!',
      body:
        emailParagraph('Tu cuenta de Nexus Battles VI se creó correctamente.') +
        emailParagraph(
          'Explora la vitrina, arma tu inventario y únete a misiones, subastas y torneos con el resto de guerreros.',
        ),
      action: { label: 'Entrar a la fortaleza', path: '/login' },
    }),
    text: emailText({
      title: '¡Te damos la bienvenida, {{displayName}}!',
      paragraphs: [
        'Tu cuenta de Nexus Battles VI se creó correctamente.',
        'Explora la vitrina, arma tu inventario y únete a misiones, subastas y torneos con el resto de guerreros.',
      ],
      action: { label: 'Entrar a la fortaleza', path: '/login' },
    }),
  },

  'commerce-order-confirmed': {
    subject: 'Confirmación de tu pedido {{orderId}}',
    html: emailLayout({
      preheader: 'Tu pedido fue confirmado por un total de {{total}}.',
      icon: 'confirmed',
      iconAlt: 'Pedido confirmado',
      title: 'Pedido confirmado',
      body:
        emailParagraph('Hola {{displayName}}, tu pedido fue confirmado.') +
        emailFacts([
          ['Pedido', '{{orderId}}'],
          ['Total', '{{total}}'],
        ]),
      action: { label: 'Ver mis pedidos', path: '/orders' },
    }),
    text: emailText({
      title: 'Pedido confirmado',
      paragraphs: [
        'Hola {{displayName}}, tu pedido {{orderId}} fue confirmado por un total de {{total}}.',
      ],
      action: { label: 'Ver mis pedidos', path: '/orders' },
    }),
  },

  'account-password-recovery-code': {
    subject: 'Restablece tu contraseña de Nexus Battles VI',
    html: emailLayout({
      preheader: 'Usa este código para restablecer tu contraseña.',
      icon: 'lock',
      iconAlt: 'Recuperación de contraseña',
      title: 'Restablece tu contraseña',
      body:
        emailParagraph(
          'Hola, recibimos una solicitud para <strong>restablecer la contraseña</strong> de tu cuenta. Escribe este código en la pantalla de recuperación:',
        ) +
        emailCode('{{code}}') +
        emailNote('Es válido por unos minutos y solo puede usarse una vez.') +
        emailNote(
          'Si no solicitaste este cambio, ignora este mensaje: tu contraseña actual no cambia mientras no se complete el proceso.',
        ),
      signature: 'Equipo Nexus Battles VI · Protegiendo tu cuenta, batalla tras batalla',
    }),
    text: emailText({
      title: 'Restablece tu contraseña',
      paragraphs: [
        'Hola, recibimos una solicitud para restablecer la contraseña de tu cuenta. Escribe este código en la pantalla de recuperación:',
        '{{code}}',
        'Es válido por unos minutos y solo puede usarse una vez.',
        'Si no solicitaste este cambio, ignora este mensaje: tu contraseña actual no cambia mientras no se complete el proceso.',
      ],
      signature: 'Equipo Nexus Battles VI · Protegiendo tu cuenta, batalla tras batalla',
    }),
  },

  'account-password-reset-confirmation': {
    subject: 'Tu contraseña de Nexus Battles VI fue actualizada',
    html: emailLayout({
      preheader: 'Ya puedes iniciar sesión con tu nueva contraseña.',
      icon: 'shield',
      iconAlt: 'Contraseña actualizada',
      title: 'Contraseña actualizada',
      body:
        emailParagraph('Hola, tu contraseña se actualizó correctamente.') +
        emailNote(
          'Si no hiciste este cambio, recupera el acceso de inmediato desde «¿Olvidaste tu contraseña?» en la pantalla de inicio de sesión.',
        ),
      action: { label: 'Iniciar sesión', path: '/login' },
      signature: 'Equipo Nexus Battles VI · Protegiendo tu cuenta, batalla tras batalla',
    }),
    text: emailText({
      title: 'Contraseña actualizada',
      paragraphs: [
        'Hola, tu contraseña se actualizó correctamente.',
        'Si no hiciste este cambio, recupera el acceso de inmediato desde «¿Olvidaste tu contraseña?» en la pantalla de inicio de sesión.',
      ],
      action: { label: 'Iniciar sesión', path: '/login' },
      signature: 'Equipo Nexus Battles VI · Protegiendo tu cuenta, batalla tras batalla',
    }),
  },

  // Sin llamada a la accion: la cuenta ya no existe. HU-43.4 limita lo que
  // este correo puede afirmar (ver la prueba del adaptador).
  'account-deletion-closed': {
    subject: 'Tu solicitud de eliminación de cuenta ha finalizado',
    html: emailLayout({
      preheader: 'El proceso de eliminación de tu cuenta terminó.',
      icon: 'check',
      iconAlt: 'Solicitud finalizada',
      title: 'Solicitud finalizada',
      body:
        emailParagraph(
          'Hola, el proceso de eliminación de tu cuenta que solicitaste ha finalizado.',
        ) + emailNote('Esta es la notificación de cierre de esa solicitud.'),
      signature: 'Equipo Nexus Battles VI · Protegiendo tu cuenta, batalla tras batalla',
    }),
    text: emailText({
      title: 'Solicitud finalizada',
      paragraphs: [
        'Hola, el proceso de eliminación de tu cuenta que solicitaste ha finalizado.',
        'Esta es la notificación de cierre de esa solicitud.',
      ],
      signature: 'Equipo Nexus Battles VI · Protegiendo tu cuenta, batalla tras batalla',
    }),
  },

  'catalog-product-created': {
    subject: '¡Nuevo producto en el catálogo: {{productName}}!',
    html: emailLayout({
      preheader: '{{productName}} ya está en la vitrina.',
      icon: 'catalog',
      iconAlt: 'Novedad del catálogo',
      title: 'Nuevo en la vitrina',
      body:
        emailParagraph('¡Atención, guerreros! Se forjó un nuevo producto en el catálogo:') +
        '{{productImageHtml}}' +
        emailFacts([
          ['Producto', '{{productName}}'],
          ['Categoría', '{{productTypeLabel}}'],
        ]) +
        emailParagraph('Ya está disponible en la vitrina para su adquisición.'),
      action: { label: 'Ir a la vitrina', path: '/ecommerce' },
    }),
    text: emailText({
      title: 'Nuevo en la vitrina',
      paragraphs: [
        '¡Atención, guerreros! Se forjó un nuevo producto en el catálogo:',
        '{{productName}} (Categoría: {{productTypeLabel}})',
        'Ya está disponible en la vitrina para su adquisición.',
      ],
      action: { label: 'Ir a la vitrina', path: '/ecommerce' },
    }),
    trustedHtml: ['productImageHtml'],
    derive: (variables) => {
      const type = read(variables, 'productType')
      const url = emailImageUrl(read(variables, 'imageUrl'))
      return {
        productTypeLabel: PRODUCT_TYPE_LABELS[type] ?? type,
        productImageHtml:
          url === null
            ? ''
            : `<img src="${escapeHtml(url)}" width="160" alt="${escapeHtml(read(variables, 'productName'))}" style="display:block;margin:0 auto 20px;max-width:160px;height:auto;border:0;image-rendering:pixelated;">`,
      }
    },
  },
}
