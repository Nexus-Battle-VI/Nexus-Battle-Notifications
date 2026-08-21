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
}

/**
 * Renderizador de plantillas por sustitucion de marcadores `{{clave}}`.
 *
 * Suficiente para el alcance de Sprint 1 y sin dependencias externas. La
 * adopcion de un motor de plantillas queda sujeta a decision arquitectonica.
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

    return Promise.resolve({
      subject: InMemoryTemplateRenderer.interpolate(template.subject, variables),
      html: InMemoryTemplateRenderer.interpolate(template.html, variables),
      text: InMemoryTemplateRenderer.interpolate(template.text, variables),
    })
  }

  has(templateId: string): boolean {
    return this.templates.has(templateId)
  }

  /** Los marcadores sin valor se sustituyen por cadena vacia, nunca por `undefined`. */
  private static interpolate(source: string, variables: RenderVariables): string {
    return source.replace(InMemoryTemplateRenderer.PLACEHOLDER, (_match, key: string) => {
      const value = variables[key]

      return value === undefined ? '' : String(value)
    })
  }
}
