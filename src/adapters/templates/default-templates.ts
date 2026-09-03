import type { TemplateDefinition } from './InMemoryTemplateRenderer.js'

/**
 * Catalogo de plantillas del alcance de Sprint 1.
 *
 * Los identificadores forman parte del contrato asincrono publicado en
 * `docs/contracts`. Anadir o retirar una plantilla es un cambio de contrato.
 */
export const DEFAULT_TEMPLATES: Readonly<Record<string, TemplateDefinition>> = {
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
