import { ConfigurationError, loadConfig } from '../../../src/infrastructure/config/env.js'
import { createLogger } from '../../../src/infrastructure/observability/logger.js'
import {
  buildLiveness,
  buildReadiness,
  buildVersion,
} from '../../../src/infrastructure/http/health.js'
import { resolveSqsSettings } from '../../../src/infrastructure/aws/sqs-settings.js'

describe('loadConfig', () => {
  it('aplica valores por defecto seguros para el entorno local', () => {
    const config = loadConfig({})

    expect(config).toMatchObject({
      nodeEnv: 'development',
      serviceName: 'nexus-battle-notifications',
      logLevel: 'info',
      healthPort: 3001,
      emailDriver: 'fake',
      queueDriver: 'memory',
      queueUrl: null,
      awsRegion: null,
      batchSize: 10,
      maxAttempts: 5,
    })
  })

  it('lee la configuracion aportada por el entorno', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      HEALTH_PORT: '8080',
      EMAIL_DRIVER: 'smtp',
      EMAIL_FROM: 'no-reply@nexus.test',
      SMTP_HOST: 'mailpit',
      SMTP_PORT: '1025',
      BATCH_SIZE: '5',
      MAX_ATTEMPTS: '3',
      RETRY_BASE_DELAY_MS: '500',
      RETRY_MAX_DELAY_MS: '5000',
      IDEMPOTENCY_TTL_MS: '3600000',
      SERVICE_VERSION: '1.2.3',
    })

    expect(config).toMatchObject({
      nodeEnv: 'production',
      logLevel: 'warn',
      healthPort: 8080,
      emailDriver: 'smtp',
      emailFrom: 'no-reply@nexus.test',
      smtpHost: 'mailpit',
      batchSize: 5,
      maxAttempts: 3,
      retryBaseDelayMs: 500,
      retryMaxDelayMs: 5_000,
      version: '1.2.3',
    })
  })

  it('trata una variable vacia como ausente', () => {
    expect(loadConfig({ LOG_LEVEL: '', BATCH_SIZE: '', QUEUE_URL: '' })).toMatchObject({
      logLevel: 'info',
      batchSize: 10,
      queueUrl: null,
    })
  })

  it('exige la configuracion de la cola cuando el driver es sqs', () => {
    expect(() => loadConfig({ QUEUE_DRIVER: 'sqs' })).toThrow(/QUEUE_URL es obligatorio/)
    expect(() =>
      loadConfig({ QUEUE_DRIVER: 'sqs', QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/cola' }),
    ).toThrow(/AWS_REGION es obligatorio/)
  })

  it('acepta una configuracion sqs completa', () => {
    const config = loadConfig({
      QUEUE_DRIVER: 'sqs',
      QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/notificaciones',
      AWS_REGION: 'us-east-1',
    })

    expect(config.queueDriver).toBe('sqs')
    expect(config.awsRegion).toBe('us-east-1')
  })

  it.each([
    ['un valor fuera del catalogo', { LOG_LEVEL: 'verbose' }],
    ['un entero mal formado', { HEALTH_PORT: 'abc' }],
    ['un decimal donde se espera entero', { BATCH_SIZE: '2.5' }],
    ['un valor fuera de rango', { BATCH_SIZE: '99' }],
    [
      'un retroceso maximo menor que el base',
      { RETRY_BASE_DELAY_MS: '5000', RETRY_MAX_DELAY_MS: '100' },
    ],
  ])('rechaza %s', (_caso, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigurationError)
  })
})

describe('createLogger', () => {
  const capture = (
    level: 'debug' | 'info' | 'warn' | 'error',
  ): { lines: string[]; logger: ReturnType<typeof createLogger> } => {
    const lines: string[] = []
    const logger = createLogger({
      level,
      service: 'notifications',
      version: '0.1.0',
      sink: (line) => lines.push(line),
      clock: () => new Date('2026-08-21T10:00:00.000Z'),
    })

    return { lines, logger }
  }

  it('emite JSON estructurado con metadatos del servicio', () => {
    const { lines, logger } = capture('info')

    logger.info('mensaje', { messageId: 'm-1', reintentos: 2, forzado: false, motivo: null })

    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      timestamp: '2026-08-21T10:00:00.000Z',
      level: 'info',
      service: 'notifications',
      version: '0.1.0',
      message: 'mensaje',
      messageId: 'm-1',
      reintentos: 2,
      forzado: false,
      motivo: null,
    })
  })

  it('descarta los registros por debajo del umbral', () => {
    const { lines, logger } = capture('warn')

    logger.debug('no')
    logger.info('no')
    logger.warn('si')
    logger.error('si')

    expect(lines).toHaveLength(2)
  })

  it('admite registros sin contexto en todos los niveles', () => {
    const { lines, logger } = capture('debug')

    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d')

    expect(lines).toHaveLength(4)
  })
})

describe('sondas de salud', () => {
  it('liveness solo confirma que el proceso responde', () => {
    expect(buildLiveness()).toEqual({ status: 'ok', checks: {} })
  })

  it('readiness es ok cuando todas las comprobaciones pasan', () => {
    expect(
      buildReadiness([
        { name: 'consumer', check: (): boolean => true },
        { name: 'queue', check: (): boolean => true },
      ]),
    ).toEqual({ status: 'ok', checks: { consumer: 'ok', queue: 'ok' } })
  })

  it('readiness falla si alguna comprobacion no pasa', () => {
    const report = buildReadiness([
      { name: 'consumer', check: (): boolean => true },
      { name: 'queue', check: (): boolean => false },
    ])

    expect(report.status).toBe('error')
    expect(report.checks).toEqual({ consumer: 'ok', queue: 'error' })
  })

  it('readiness trata una excepcion como fallo, no como exito', () => {
    const report = buildReadiness([
      {
        name: 'queue',
        check: (): boolean => {
          throw new Error('sin conexion')
        },
      },
    ])

    expect(report).toEqual({ status: 'error', checks: { queue: 'error' } })
  })

  it('readiness sin comprobaciones no puede afirmar disponibilidad de dependencias', () => {
    expect(buildReadiness([])).toEqual({ status: 'ok', checks: {} })
  })

  it('version expone servicio, version y entorno', () => {
    expect(
      buildVersion({ service: 'notifications', version: '0.1.0', nodeEnv: 'production' }),
    ).toEqual({ service: 'notifications', version: '0.1.0', nodeEnv: 'production' })
  })
})

describe('resolveSqsSettings', () => {
  it('deriva el nombre de la cola desde la URL', () => {
    expect(
      resolveSqsSettings({
        region: 'us-east-1',
        queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/notificaciones',
      }),
    ).toEqual({
      region: 'us-east-1',
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/notificaciones',
      queueName: 'notificaciones',
    })
  })

  it.each([
    ['sin region', { region: null, queueUrl: 'https://sqs.us-east-1.amazonaws.com/1/cola' }],
    ['con region vacia', { region: '  ', queueUrl: 'https://sqs.us-east-1.amazonaws.com/1/cola' }],
    ['sin URL', { region: 'us-east-1', queueUrl: null }],
    ['con URL vacia', { region: 'us-east-1', queueUrl: '   ' }],
    ['con URL invalida', { region: 'us-east-1', queueUrl: 'no-es-una-url' }],
    [
      'con URL sin nombre de cola',
      { region: 'us-east-1', queueUrl: 'https://sqs.us-east-1.amazonaws.com/' },
    ],
  ])('rechaza una configuracion %s', (_caso, params) => {
    expect(() => resolveSqsSettings(params)).toThrow(ConfigurationError)
  })
})
