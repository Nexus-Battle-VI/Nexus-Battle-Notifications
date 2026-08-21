export interface RenderedTemplate {
  readonly subject: string
  readonly html: string
  readonly text: string
}

export type RenderVariables = Readonly<Record<string, string | number | boolean>>

/**
 * Puerto de renderizado de plantillas. El caso de uso no conoce el motor.
 */
export interface TemplateRendererPort {
  render(templateId: string, variables: RenderVariables): Promise<RenderedTemplate>
}

export class TemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`No existe la plantilla "${templateId}".`)
    this.name = 'TemplateNotFoundError'
  }
}
