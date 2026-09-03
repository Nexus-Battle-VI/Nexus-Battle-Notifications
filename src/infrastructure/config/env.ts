export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export const EmailDriver = {
  Fake: 'fake',
  Smtp: 'smtp',
  Ses: 'ses',
} as const

export type EmailDriver = (typeof EmailDriver)[keyof typeof EmailDriver]

export const QueueDriver = {
  Memory: 'memory',
  Sqs: 'sqs',
} as const

export type QueueDriver = (typeof QueueDriver)[keyof typeof QueueDriver]

export interface PurchaseConfig {
  readonly port: number
  readonly secret: string
  readonly inboxDriver: 'mongo' | 'memory'
  readonly mongoUrl: string | null
  readonly databaseName: string
}

export interface AppConfig {
  readonly purchase: PurchaseConfig | null
  readonly nodeEnv: 'development' | 'test' | 'production'
  readonly serviceName: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  readonly healthPort: number
  readonly ingestEnabled: boolean
  readonly ingestPort: number
  readonly ingestSharedSecret: string | null
  readonly emailDriver: EmailDriver
  readonly emailFrom: string
  readonly smtpHost: string
  readonly smtpPort: number
  readonly smtpUser: string | null
  readonly smtpPass: string | null
  readonly queueDriver: QueueDriver
  readonly queueUrl: string | null
  readonly deadLetterQueueUrl: string | null
  readonly catalogQueueUrl: string | null
  readonly awsRegion: string | null
  readonly pollIntervalMs: number
  readonly batchSize: number
  readonly maxAttempts: number
  readonly retryBaseDelayMs: number
  readonly retryMaxDelayMs: number
  readonly idempotencyTtlMs: number
}

type RawEnv = Readonly<Record<string, string | undefined>>

const readEnum = <T extends string>(
  env: RawEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigurationError(
      `${key} debe ser uno de: ${allowed.join(', ')}. Se recibio "${raw}".`,
    )
  }

  return raw as T
}

const readInteger = (
  env: RawEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed)) {
    throw new ConfigurationError(`${key} debe ser un numero entero. Se recibio "${raw}".`)
  }

  if (parsed < min || parsed > max) {
    throw new ConfigurationError(
      `${key} debe estar entre ${String(min)} y ${String(max)}. Se recibio ${String(parsed)}.`,
    )
  }

  return parsed
}

const readString = (env: RawEnv, key: string, fallback: string): string => {
  const raw = env[key]

  return raw === undefined || raw === '' ? fallback : raw
}

/**
 * Solo admite "true" y "false" literales. Un valor cualquiera no se interpreta
 * como verdadero: activar por accidente un servidor que recibe peticiones seria
 * justo el tipo de sorpresa que esta configuracion debe evitar.
 */
const readBoolean = (env: RawEnv, key: string, fallback: boolean): boolean => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  if (raw !== 'true' && raw !== 'false') {
    throw new ConfigurationError(`${key} debe ser "true" o "false". Se recibio "${raw}".`)
  }

  return raw === 'true'
}

/**
 * Construye la configuracion a partir del entorno. Es una funcion pura sobre
 * `env`: no lee `process.env` directamente, de modo que puede verificarse
 * completa sin contaminar el proceso de pruebas.
 *
 * Falla de inmediato ante una configuracion invalida. Un worker mal configurado
 * no debe arrancar y aparentar salud.
 */
export const loadConfig = (env: RawEnv): AppConfig => {
  const nodeEnv = readEnum(
    env,
    'NODE_ENV',
    ['development', 'test', 'production'] as const,
    'development',
  )
  const emailDriver = readEnum(
    env,
    'EMAIL_DRIVER',
    [EmailDriver.Fake, EmailDriver.Smtp, EmailDriver.Ses],
    EmailDriver.Fake,
  )
  const queueDriver = readEnum(
    env,
    'QUEUE_DRIVER',
    [QueueDriver.Memory, QueueDriver.Sqs],
    QueueDriver.Memory,
  )
  const queueUrl = env['QUEUE_URL'] ?? null
  const deadLetterQueueUrl = env['DEAD_LETTER_QUEUE_URL'] ?? env['DLQ_URL'] ?? null
  const catalogQueueUrl = env['CATALOG_QUEUE_URL'] ?? env['CATALOG_EVENTS_QUEUE_URL'] ?? null
  const awsRegion = env['AWS_REGION'] ?? null

  if (emailDriver === EmailDriver.Ses && (awsRegion === null || awsRegion === '')) {
    throw new ConfigurationError('AWS_REGION es obligatorio cuando EMAIL_DRIVER es "ses".')
  }

  if (queueDriver === QueueDriver.Sqs) {
    if (queueUrl === null || queueUrl === '') {
      throw new ConfigurationError('QUEUE_URL es obligatorio cuando QUEUE_DRIVER es "sqs".')
    }

    if (awsRegion === null || awsRegion === '') {
      throw new ConfigurationError('AWS_REGION es obligatorio cuando QUEUE_DRIVER es "sqs".')
    }
  }

  const healthPort = readInteger(env, 'HEALTH_PORT', 3001, 1, 65_535)
  const ingestEnabled = readBoolean(env, 'INGEST_ENABLED', false)
  const ingestPort = readInteger(env, 'INGEST_PORT', 3002, 1, 65_535)

  // Dos servidores no pueden compartir puerto: el segundo fallaria al escuchar
  // con EADDRINUSE, ya arrancado el proceso y con las sondas respondiendo. Se
  // detecta aqui para que el worker no arranque aparentando salud.
  if (ingestEnabled && ingestPort === healthPort) {
    throw new ConfigurationError(
      'INGEST_PORT no puede coincidir con HEALTH_PORT: son dos servidores distintos.',
    )
  }

  const retryBaseDelayMs = readInteger(env, 'RETRY_BASE_DELAY_MS', 1_000, 0, 600_000)
  const retryMaxDelayMs = readInteger(env, 'RETRY_MAX_DELAY_MS', 60_000, 0, 3_600_000)
  let purchase: PurchaseConfig | null = null
  if (readBoolean(env, 'PURCHASE_HTTP_ENABLED', false)) {
    const port = readInteger(env, 'PURCHASE_HTTP_PORT', 3003, 1, 65535)
    const secret = readString(env, 'INTERNAL_SERVICE_AUTH_SECRET', '')
    const inboxDriver = readEnum(
      env,
      'PURCHASE_INBOX_DRIVER',
      ['mongo', 'memory'] as const,
      'mongo',
    )
    const mongoUrl = readString(env, 'MONGO_URL', '') || null
    if (secret === '')
      throw new ConfigurationError('INTERNAL_SERVICE_AUTH_SECRET es obligatorio para compras.')
    if (inboxDriver === 'mongo' && mongoUrl === null)
      throw new ConfigurationError('MONGO_URL es obligatorio para el inbox de compras.')
    if (nodeEnv === 'production' && (inboxDriver !== 'mongo' || emailDriver === EmailDriver.Fake)) {
      throw new ConfigurationError(
        'Las compras en produccion requieren inbox Mongo y un proveedor real de correo.',
      )
    }
    if (port === healthPort || (ingestEnabled && port === ingestPort))
      throw new ConfigurationError('PURCHASE_HTTP_PORT debe ser distinto de los otros puertos.')
    purchase = {
      port,
      secret,
      inboxDriver,
      mongoUrl,
      databaseName: readString(env, 'MONGO_DB_NAME', 'notifications'),
    }
  }

  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new ConfigurationError('RETRY_MAX_DELAY_MS no puede ser menor que RETRY_BASE_DELAY_MS.')
  }

  return {
    nodeEnv,
    purchase,
    serviceName: readString(env, 'SERVICE_NAME', 'nexus-battle-notifications'),
    version: readString(env, 'SERVICE_VERSION', '0.1.0'),
    logLevel: readEnum(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    healthPort,
    ingestEnabled,
    ingestPort,
    ingestSharedSecret: readString(env, 'INGEST_SHARED_SECRET', '') || null,
    emailDriver,
    emailFrom: readString(env, 'EMAIL_FROM', 'no-reply@nexus-battles.local'),
    smtpHost: readString(env, 'SMTP_HOST', 'localhost'),
    smtpPort: readInteger(env, 'SMTP_PORT', 1025, 1, 65_535),
    smtpUser: readString(env, 'SMTP_USER', '') || null,
    smtpPass: readString(env, 'SMTP_PASS', '') || null,
    queueDriver,
    queueUrl: queueUrl === '' ? null : queueUrl,
    deadLetterQueueUrl: deadLetterQueueUrl === '' ? null : deadLetterQueueUrl,
    catalogQueueUrl: catalogQueueUrl === '' ? null : catalogQueueUrl,
    awsRegion: awsRegion === '' ? null : awsRegion,
    pollIntervalMs: readInteger(env, 'POLL_INTERVAL_MS', 1_000, 10, 60_000),
    batchSize: readInteger(env, 'BATCH_SIZE', 10, 1, 10),
    maxAttempts: readInteger(env, 'MAX_ATTEMPTS', 5, 1, 20),
    retryBaseDelayMs,
    retryMaxDelayMs,
    idempotencyTtlMs: readInteger(env, 'IDEMPOTENCY_TTL_MS', 86_400_000, 1_000, 604_800_000),
  }
}
