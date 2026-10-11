import type {
  RenderVariables,
  RenderedTemplate,
  TemplateRendererPort,
} from '../../application/ports/TemplateRendererPort.js'
import { TemplateNotFoundError } from '../../application/ports/TemplateRendererPort.js'

export interface TemplateDefinition {
  readonly subject: string
  readonly html: string
  readonly text: string
  /**
   * Variables cuyo valor YA es HTML seguro y se insertan sin escapar en `html`.
   * Cualquier otra se escapa: el valor de una variable es texto, venga de
   * donde venga (un nombre de producto, un motivo de sancion).
   */
  readonly trustedHtml?: readonly string[]
  /**
   * Variables de presentacion calculadas a partir de las recibidas (fechas
   * legibles, etiquetas traducidas). Se aplican DESPUES de las recibidas, asi
   * que quien llama no puede suplantarlas: si una aparece en `trustedHtml`,
   * `derive` debe devolverla siempre, aunque sea vacia.
   */
  readonly derive?: (variables: RenderVariables) => RenderVariables
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character)

/**
 * Renderizador de plantillas por sustitucion de marcadores `{{clave}}`.
 *
 * Suficiente para el alcance actual y sin dependencias externas. La adopcion
 * de un motor de plantillas queda sujeta a decision arquitectonica.
 *
 * En `html` cada valor se escapa salvo los declarados en `trustedHtml`; en
 * `subject` y `text` se inserta tal cual, porque no se interpretan como HTML.
 */
export class InMemoryTemplateRenderer implements TemplateRendererPort {
  private static readonly PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

  private readonly templates: ReadonlyMap<string, TemplateDefinition>

  constructor(templates: ReadonlyMap<string, TemplateDefinition>) {
    this.templates = templates
  }

  static fromRecord(
    record: Readonly<Record<string, TemplateDefinition>>,
  ): InMemoryTemplateRenderer {
    return new InMemoryTemplateRenderer(new Map(Object.entries(record)))
  }

  render(templateId: string, variables: RenderVariables): Promise<RenderedTemplate> {
    const template = this.templates.get(templateId)

    if (template === undefined) {
      return Promise.reject(new TemplateNotFoundError(templateId))
    }

    const values: RenderVariables = { ...variables, ...template.derive?.(variables) }
    const trusted = new Set(template.trustedHtml ?? [])
    const asText = (_key: string, value: string): string => value
    const asHtml = (key: string, value: string): string =>
      trusted.has(key) ? value : escapeHtml(value)

    return Promise.resolve({
      subject: InMemoryTemplateRenderer.interpolate(template.subject, values, asText),
      html: InMemoryTemplateRenderer.interpolate(template.html, values, asHtml),
      text: InMemoryTemplateRenderer.interpolate(template.text, values, asText),
    })
  }

  has(templateId: string): boolean {
    return this.templates.has(templateId)
  }

  /** Los marcadores sin valor se sustituyen por cadena vacia, nunca por `undefined`. */
  private static interpolate(
    source: string,
    variables: RenderVariables,
    encode: (key: string, value: string) => string,
  ): string {
    return source.replace(InMemoryTemplateRenderer.PLACEHOLDER, (_match, key: string) => {
      const value = variables[key]

      return value === undefined ? '' : encode(key, String(value))
    })
  }
}
