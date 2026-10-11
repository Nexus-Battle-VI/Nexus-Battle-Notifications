import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from '@jest/globals'

import type { RenderVariables } from '../../../src/application/ports/TemplateRendererPort.js'
import {
  DEFAULT_TEMPLATES,
  formatEmailDate,
} from '../../../src/adapters/templates/default-templates.js'
import { PUBLIC_WEB_URL } from '../../../src/adapters/templates/email-layout.js'
import { InMemoryTemplateRenderer } from '../../../src/adapters/templates/InMemoryTemplateRenderer.js'

/**
 * Plantillas de correo con el armazon de EN-031.
 *
 * Con `EMAIL_PREVIEW_DIR=<carpeta>` la prueba escribe ademas cada correo
 * renderizado como `<plantilla>.html`, para revisarlo en un navegador:
 *
 *   EMAIL_PREVIEW_DIR=./email-previews npm run test:unit -- email-templates
 */
const renderer = InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES)

/** Las variables que envia hoy cada productor (Account, Commerce, Catalog). */
const SAMPLES: Readonly<Record<string, RenderVariables>> = {
  'account-sanction-applied': {
    displayName: 'Dabji',
    sanctionId: 'b2f9a1c4-0d3e-4c55-9b0e-6f1f5d2a7e10',
    sanctionType: 'TEMPORARY_SUSPENSION',
    reason: 'Lenguaje ofensivo reiterado en el chat de sala.',
    appliedAt: '2026-10-11T15:30:00.000Z',
    appealDeadline: '2026-10-18T15:30:00.000Z',
    appealWindowDays: 7,
    expiresAt: '2026-10-14T15:30:00.000Z',
  },
  'account-appeal-received': {
    displayName: 'Dabji',
    appealId: 'ap-4f2e1a90',
    sanctionId: 'b2f9a1c4-0d3e-4c55-9b0e-6f1f5d2a7e10',
    sanctionType: 'TEMPORARY_SUSPENSION',
    submittedAt: '2026-10-11T15:30:00.000Z',
    decisionDueAt: '2026-11-01T15:30:00.000Z',
  },
  'account-appeal-resolved': {
    displayName: 'Dabji',
    appealId: 'ap-4f2e1a90',
    sanctionId: 'b2f9a1c4-0d3e-4c55-9b0e-6f1f5d2a7e10',
    sanctionType: 'TEMPORARY_SUSPENSION',
    decision: 'OVERTURNED',
    resolutionNotes: 'La evidencia aportada desvirtúa la causal original.',
    resolvedAt: '2026-10-20T15:30:00.000Z',
  },
  'commerce-purchase-confirmed-v1': {
    orderId: 'ORD-2026-0042',
    total: 'COP 61.00',
    itemsHtml: '<li>Espada del Alba x2 — COP 30.50; subtotal COP 61.00</li>',
    itemsText: 'Espada del Alba x2 — COP 30.50; subtotal COP 61.00',
  },
  'account-verification-code': { displayName: 'Dabji', code: '482913', expiresInMinutes: 10 },
  'account-welcome': { displayName: 'Dabji' },
  'commerce-order-confirmed': { displayName: 'Dabji', orderId: 'ORD-9', total: 'COP 120.00' },
  'account-password-recovery-code': { code: '730215' },
  'account-password-reset-confirmation': {},
  'account-deletion-closed': {},
  'catalog-product-created': {
    productName: 'Espada de Fuego',
    productType: 'ARMA',
    productId: 'prod-1',
    imageUrl: '/assets/catalog/espada-de-fuego.png',
  },
}

const TEMPLATE_IDS = Object.keys(DEFAULT_TEMPLATES)

describe('plantillas de correo (EN-031)', () => {
  it('hay un ejemplo para cada plantilla del catalogo', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...TEMPLATE_IDS].sort())
  })

  it.each(TEMPLATE_IDS)(
    '%s se renderiza completa: sin marcadores sobrantes, con texto y bajo el limite de Gmail',
    async (templateId) => {
      const rendered = await renderer.render(templateId, SAMPLES[templateId] ?? {})

      for (const part of [rendered.subject, rendered.html, rendered.text]) {
        expect(part).not.toMatch(/\{\{|\}\}/u)
        expect(part).not.toContain('undefined')
      }
      expect(rendered.html.startsWith('<!DOCTYPE html>')).toBe(true)
      expect(rendered.html).toContain(`${PUBLIC_WEB_URL}/assets/email/header.png`)
      expect(rendered.html).toContain(`${PUBLIC_WEB_URL}/assets/email/logo.png`)
      expect(rendered.html).toContain('Este buzón no recibe respuestas')
      expect(rendered.text).toContain('Este buzón no recibe respuestas')
      expect(rendered.text.trim().length).toBeGreaterThan(40)
      // Gmail recorta los mensajes de mas de ~102 KB.
      expect(Buffer.byteLength(rendered.html, 'utf8')).toBeLessThan(100 * 1024)
      // Ninguna imagen sin texto alternativo.
      for (const image of rendered.html.match(/<img\b[^>]*>/gu) ?? []) {
        expect(image).toMatch(/\balt="[^"]+"/u)
      }

      const previewDir = process.env['EMAIL_PREVIEW_DIR']
      if (previewDir !== undefined && previewDir !== '') {
        mkdirSync(previewDir, { recursive: true })
        writeFileSync(path.join(previewDir, `${templateId}.html`), rendered.html)
        writeFileSync(path.join(previewDir, `${templateId}.txt`), rendered.text)
      }
    },
  )

  it('escapa el valor de cualquier variable en el HTML (control: un <b> no sale como etiqueta)', async () => {
    const rendered = await renderer.render('account-sanction-applied', {
      ...SAMPLES['account-sanction-applied'],
      displayName: '<b>Ana</b>',
      reason: '<script>alert(1)</script>',
    })

    expect(rendered.html).toContain('&lt;b&gt;Ana&lt;/b&gt;')
    expect(rendered.html).not.toContain('<b>Ana</b>')
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(rendered.html).not.toContain('<script>')
    // El texto plano no se interpreta: se conserva literal.
    expect(rendered.text).toContain('<b>Ana</b>')
  })

  it('escapa tambien las comillas, para que un valor no salga de un atributo', async () => {
    const rendered = await renderer.render('account-welcome', { displayName: '" onload="x' })

    expect(rendered.html).toContain('&quot; onload=&quot;x')
    expect(rendered.html).not.toContain('" onload="x')
  })

  it('solo inserta sin escapar las variables declaradas como HTML de confianza', async () => {
    const rendered = await renderer.render('commerce-purchase-confirmed-v1', {
      ...SAMPLES['commerce-purchase-confirmed-v1'],
      orderId: '<i>ORD</i>',
    })

    expect(rendered.html).toContain('<li>Espada del Alba x2')
    expect(rendered.html).toContain('&lt;i&gt;ORD&lt;/i&gt;')
  })

  it('quien llama no puede suplantar una variable derivada de confianza', async () => {
    const rendered = await renderer.render('catalog-product-created', {
      ...SAMPLES['catalog-product-created'],
      imageUrl: 'javascript:alert(1)',
      productImageHtml: '<script>alert(1)</script>',
    })

    expect(rendered.html).not.toContain('<script>')
    expect(rendered.html).not.toContain('javascript:')
  })

  describe('sancion', () => {
    it('traduce el tipo y formatea las fechas en espanol de Colombia', async () => {
      const rendered = await renderer.render(
        'account-sanction-applied',
        SAMPLES['account-sanction-applied'] ?? {},
      )

      expect(rendered.html).toContain('Suspensión temporal')
      expect(rendered.html).not.toContain('TEMPORARY_SUSPENSION')
      expect(rendered.html).not.toContain('2026-10-11T15:30:00.000Z')
      expect(rendered.text).toContain('Aplicada el: 11 de octubre de 2026')
      expect(rendered.text).toContain('La suspensión termina el: 14 de octubre de 2026')
    })

    it('sin fecha de fin no menciona el final de la suspension', async () => {
      const rendered = await renderer.render('account-sanction-applied', {
        ...SAMPLES['account-sanction-applied'],
        sanctionType: 'WARNING',
        expiresAt: '',
      })

      expect(rendered.html).toContain('Advertencia')
      expect(rendered.html).not.toContain('termina el')
      expect(rendered.text).not.toContain('termina el')
    })

    it('una fecha que no es ISO no se inventa', () => {
      expect(formatEmailDate('')).toBe('')
      expect(formatEmailDate('no-es-fecha')).toBe('')
      expect(formatEmailDate('2026-10-11T15:30:00.000Z')).toContain('(hora de Colombia)')
    })
  })

  describe('apelacion', () => {
    it('account-appeal-received traduce el tipo de sancion y formatea las fechas', async () => {
      const rendered = await renderer.render(
        'account-appeal-received',
        SAMPLES['account-appeal-received'] ?? {},
      )

      expect(rendered.html).toContain('Suspensión temporal')
      expect(rendered.html).not.toContain('TEMPORARY_SUSPENSION')
      expect(rendered.text).toContain('Presentada el: 11 de octubre de 2026')
      expect(rendered.text).toContain('ap-4f2e1a90')
    })

    it('account-appeal-resolved traduce la decision OVERTURNED', async () => {
      const rendered = await renderer.render(
        'account-appeal-resolved',
        SAMPLES['account-appeal-resolved'] ?? {},
      )

      expect(rendered.html).toContain('Se revirtió la sanción')
      expect(rendered.html).not.toContain('OVERTURNED')
      expect(rendered.text).toContain('desvirtúa la causal original')
    })

    it('account-appeal-resolved traduce la decision UPHELD', async () => {
      const rendered = await renderer.render('account-appeal-resolved', {
        ...SAMPLES['account-appeal-resolved'],
        decision: 'UPHELD',
      })

      expect(rendered.html).toContain('Se mantiene la sanción')
      expect(rendered.html).not.toContain('UPHELD')
    })

    it('account-appeal-resolved escapa el motivo de la decision (texto libre)', async () => {
      const rendered = await renderer.render('account-appeal-resolved', {
        ...SAMPLES['account-appeal-resolved'],
        resolutionNotes: '<script>alert(1)</script>',
      })

      expect(rendered.html).not.toContain('<script>')
      expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    })
  })

  describe('producto del catalogo', () => {
    it('usa la imagen del producto: una ruta de Web se completa con el dominio publico', async () => {
      const rendered = await renderer.render(
        'catalog-product-created',
        SAMPLES['catalog-product-created'] ?? {},
      )

      expect(rendered.html).toContain(
        `src="${PUBLIC_WEB_URL}/assets/catalog/espada-de-fuego.png" width="160" alt="Espada de Fuego"`,
      )
      expect(rendered.html).toContain('Arma')
    })

    it('acepta una URL absoluta y descarta una que no sea http(s)', async () => {
      const absolute = await renderer.render('catalog-product-created', {
        ...SAMPLES['catalog-product-created'],
        imageUrl: 'https://cdn.ejemplo.test/espada.png',
      })
      const protocolRelative = await renderer.render('catalog-product-created', {
        ...SAMPLES['catalog-product-created'],
        imageUrl: '//otro.test/espada.png',
      })

      expect(absolute.html).toContain('src="https://cdn.ejemplo.test/espada.png"')
      expect(protocolRelative.html).not.toContain('otro.test')
    })
  })

  it('la llamada a la accion apunta a la ruta de Web que corresponde', async () => {
    const welcome = await renderer.render('account-welcome', { displayName: 'Ana' })
    const deletion = await renderer.render('account-deletion-closed', {})

    expect(welcome.html).toContain(`href="${PUBLIC_WEB_URL}/login"`)
    expect(welcome.text).toContain(`Entrar a la fortaleza: ${PUBLIC_WEB_URL}/login`)
    // La cuenta eliminada no tiene adonde volver.
    expect(deletion.html).not.toContain(`href="${PUBLIC_WEB_URL}/`)
  })
})
