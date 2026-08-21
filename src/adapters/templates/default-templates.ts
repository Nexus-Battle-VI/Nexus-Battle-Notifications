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
}
