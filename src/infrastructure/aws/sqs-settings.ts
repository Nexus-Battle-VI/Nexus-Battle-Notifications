import { ConfigurationError } from '../config/env.js'

export interface SqsSettings {
  readonly region: string
  readonly queueUrl: string
  readonly queueName: string
}

/**
 * Valida y deriva los parametros de una cola SQS a partir de la configuracion.
 *
 * No instancia ningun cliente de AWS: el adaptador SQS permanece como candidato
 * sujeto a ADR-006 y no se provisiona infraestructura en este Sprint. Esta
 * funcion existe para que la decision de adoptarlo no requiera rehacer la
 * configuracion ni el arranque del worker.
 */
export const resolveSqsSettings = (params: {
  region: string | null
  queueUrl: string | null
}): SqsSettings => {
  if (params.region === null || params.region.trim() === '') {
    throw new ConfigurationError('La region de AWS es obligatoria para resolver la cola SQS.')
  }

  if (params.queueUrl === null || params.queueUrl.trim() === '') {
    throw new ConfigurationError('La URL de la cola SQS es obligatoria.')
  }

  let parsed: URL

  try {
    parsed = new URL(params.queueUrl)
  } catch {
    throw new ConfigurationError(`La URL de la cola SQS no es valida: "${params.queueUrl}".`)
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0)
  const queueName = segments.at(-1)

  if (queueName === undefined) {
    throw new ConfigurationError(
      `La URL de la cola SQS no contiene un nombre de cola: "${params.queueUrl}".`,
    )
  }

  return { region: params.region, queueUrl: params.queueUrl, queueName }
}
