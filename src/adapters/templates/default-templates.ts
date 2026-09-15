import type { TemplateDefinition } from './InMemoryTemplateRenderer.js'

/**
 * Catalogo de plantillas del alcance de Sprint 1.
 *
 * Los identificadores forman parte del contrato asincrono publicado en
 * `docs/contracts`. Anadir o retirar una plantilla es un cambio de contrato.
 */
export const DEFAULT_TEMPLATES: Readonly<Record<string, TemplateDefinition>> = {
  'account-sanction-applied': {
    subject: 'Nexus Battles — Se ha aplicado una sancion a tu cuenta',
    html:
      '<p>⚔️ <strong>Nexus Battles</strong></p>' +
      '<p>Hola {{displayName}},</p>' +
      '<p>Se ha aplicado una sancion a tu cuenta.</p>' +
      '<p><strong>Tipo de sancion:</strong> {{sanctionType}}</p>' +
      '<p><strong>Motivo:</strong> {{reason}}</p>' +
      '<p><strong>Fecha de aplicacion:</strong> {{appliedAt}}</p>' +
      '<p><strong>Identificador de sancion:</strong> {{sanctionId}}</p>' +
      '<p>Puedes ejercer tu opcion de apelacion durante los siguientes <strong>{{appealWindowDays}} dias</strong>.</p>' +
      '<p><strong>Fecha limite para apelar:</strong> {{appealDeadline}}</p>' +
      '<p>Si la sancion corresponde a una suspension temporal, su fecha de finalizacion es: {{expiresAt}}</p>' +
      '<p><strong>Equipo Nexus Battles</strong><br>Promoviendo una comunidad segura y justa.</p>',
    text:
      'Nexus Battles\n\n' +
      'Hola {{displayName}},\n\n' +
      'Se ha aplicado una sancion a tu cuenta.\n\n' +
      'Tipo de sancion: {{sanctionType}}\n' +
      'Motivo: {{reason}}\n' +
      'Fecha de aplicacion: {{appliedAt}}\n' +
      'Identificador de sancion: {{sanctionId}}\n\n' +
      'Puedes ejercer tu opcion de apelacion durante los siguientes {{appealWindowDays}} dias.\n' +
      'Fecha limite para apelar: {{appealDeadline}}\n' +
      'Fecha de finalizacion de suspension, cuando aplique: {{expiresAt}}\n\n' +
      'Equipo Nexus Battles\nPromoviendo una comunidad segura y justa.',
  },

  'commerce-purchase-confirmed-v1': {
    subject: 'Nexus Battles VI — Confirmacion de compra {{orderId}}',
    html: '<p><strong>Nexus Battles VI · UPB-COMPANY</strong></p><p>Tu compra simulada {{orderId}} se completo correctamente.</p><ul>{{itemsHtml}}</ul><p><strong>Total pagado: {{total}}</strong></p><p>Gracias por jugar con nosotros. Equipo Nexus Battles VI.</p>',
    text: 'Nexus Battles VI · UPB-COMPANY\nTu compra simulada {{orderId}} se completo correctamente.\n{{itemsText}}\nTotal pagado: {{total}}\nGracias por jugar con nosotros. Equipo Nexus Battles VI.',
  },
  'account-verification-code': {
    subject: 'Tu codigo de verificacion de Nexus Battles',
    html: '<p>Hola {{displayName}},</p><p>Tu codigo de verificacion es <strong>{{code}}</strong>. Caduca en {{expiresInMinutes}} minutos.</p>',
    text: 'Hola {{displayName}}, tu codigo de verificacion es {{code}}. Caduca en {{expiresInMinutes}} minutos.',
  },
  'account-welcome': {
    subject: 'Bienvenido a Nexus Battles',
    html: '<p>Hola {{displayName}},</p><p>Tu cuenta fue creada correctamente.</p>',
    text: 'Hola {{displayName}}, tu cuenta fue creada correctamente.',
  },
  'commerce-order-confirmed': {
    subject: 'Confirmacion de tu pedido {{orderId}}',
    html: '<p>Hola {{displayName}},</p><p>Tu pedido <strong>{{orderId}}</strong> fue confirmado por un total de {{total}}.</p>',
    text: 'Hola {{displayName}}, tu pedido {{orderId}} fue confirmado por un total de {{total}}.',
  },
  'account-password-recovery-code': {
    subject: 'Restablece tu contraseña de Nexus Battles',
    html:
      '<p>⚔️ <strong>Nexus Battles</strong></p>' +
      '<p>Hola, hemos recibido una solicitud para <strong>restablecer la contraseña</strong> de tu cuenta.</p>' +
      '<p>Para continuar con el proceso, utiliza el siguiente código de verificación:</p>' +
      '<p><strong>{{code}}</strong></p>' +
      '<p>Este código es válido por unos minutos y solo puede utilizarse una vez.</p>' +
      '<p>Si <strong>no solicitaste este cambio</strong>, puedes ignorar este mensaje. Tu contraseña actual no se modificará mientras no se complete el proceso.</p>' +
      '<p><strong>Equipo Nexus Battles</strong><br>Protegiendo tu cuenta, batalla tras batalla.</p>',
    text:
      'Nexus Battles\n\n' +
      'Hola, hemos recibido una solicitud para restablecer la contraseña de tu cuenta.\n\n' +
      'Para continuar con el proceso, utiliza el siguiente código de verificación:\n\n' +
      '{{code}}\n\n' +
      'Este código es válido por unos minutos y solo puede utilizarse una vez.\n\n' +
      'Si no solicitaste este cambio, puedes ignorar este mensaje. Tu contraseña actual no se modificará mientras no se complete el proceso.\n\n' +
      'Equipo Nexus Battles\nProtegiendo tu cuenta, batalla tras batalla.',
  },
  'account-password-reset-confirmation': {
    subject: 'Tu contraseña de Nexus Battles fue actualizada',
    html:
      '<p>⚔️ <strong>Nexus Battles</strong></p>' +
      '<p>Hola, tu contraseña se actualizó correctamente.</p>' +
      '<p>Si <strong>no solicitaste este cambio</strong>, avisa al equipo.</p>' +
      '<p><strong>Equipo Nexus Battles</strong><br>Protegiendo tu cuenta, batalla tras batalla.</p>',
    text:
      'Nexus Battles\n\n' +
      'Hola, tu contraseña se actualizó correctamente.\n\n' +
      'Si no solicitaste este cambio, avisa al equipo.\n\n' +
      'Equipo Nexus Battles\nProtegiendo tu cuenta, batalla tras batalla.',
  },
  'account-deletion-closed': {
    subject: 'Tu solicitud de eliminación de cuenta ha finalizado',
    html:
      '<p>⚔️ <strong>Nexus Battles</strong></p>' +
      '<p>Hola, el proceso de eliminación de tu cuenta que solicitaste ha finalizado.</p>' +
      '<p>Esta es la notificación de cierre de esa solicitud.</p>' +
      '<p><strong>Equipo Nexus Battles</strong><br>Protegiendo tu cuenta, batalla tras batalla.</p>',
    text:
      'Nexus Battles\n\n' +
      'Hola, el proceso de eliminación de tu cuenta que solicitaste ha finalizado.\n\n' +
      'Esta es la notificación de cierre de esa solicitud.\n\n' +
      'Equipo Nexus Battles\nProtegiendo tu cuenta, batalla tras batalla.',
  },
  'catalog-product-created': {
    subject: '¡Nuevo producto en el catálogo: {{productName}}!',
    html:
      '<p>⚔️ <strong>Nexus Battles</strong></p>' +
      '<p>¡Atención, guerreros! Se ha forjado un nuevo producto en el catálogo:</p>' +
      '<p><strong>{{productName}}</strong> (Categoría: <em>{{productType}}</em>)</p>' +
      '<p>Ya está disponible en la vitrina para su adquisición.</p>',
    text:
      'Nexus Battles\n\n' +
      '¡Atención, guerreros! Se ha forjado un nuevo producto en el catálogo:\n\n' +
      '{{productName}} (Categoría: {{productType}})\n\n' +
      'Ya está disponible en la vitrina para su adquisición.\n',
  },
}
