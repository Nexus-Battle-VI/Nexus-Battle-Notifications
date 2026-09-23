import { ConfigurationError, loadConfig } from '../../../src/infrastructure/config/env.js'
import { createLogger } from '../../../src/infrastructure/observability/logger.js'
import {
  buildLiveness,
  buildReadiness,
  buildVersion,
} from '../../../src/infrastructure/http/health.js'
import { resolveSqsSettings } from '../../../src/infrastructure/aws/sqs-settings.js'

describe('loadConfig', () => {
  describe('AUCTION_SETTLEMENT_QUEUE_DRIVER', () => {
    const base = {
      CATALOG_NOTIFICATIONS_HTTP_ENABLED: 'true',
      CATALOG_NOTIFICATIONS_REPOSITORY_DRIVER: 'memory',
      COGNITO_USER_POOL_ID: 'pool',
      COGNITO_CLIENT_ID: 'client',
    }

    it('memory no exige URL', () => {
      expect(
        loadConfig({ ...base, AUCTION_SETTLEMENT_QUEUE_DRIVER: 'memory' }).catalogNotifications
          ?.auctionSettlementQueueUrl,
      ).toBeNull()
    })

    it('sqs fail-closed sin URL o region', () => {
      expect(() => loadConfig({ ...base, AUCTION_SETTLEMENT_QUEUE_DRIVER: 'sqs' })).toThrow(
        /AUCTION_SETTLEMENT_QUEUE_URL/,
      )
      expect(() =>
        loadConfig({
          ...base,
          AUCTION_SETTLEMENT_QUEUE_DRIVER: 'sqs',
          AUCTION_SETTLEMENT_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/settlement',
        }),
      ).toThrow(/AWS_REGION/)
    })
  })
  it('aplica valores por defecto seguros para el entorno local', () => {
    const config = loadConfig({})

    expect(config).toMatchObject({
      nodeEnv: 'development',
      serviceName: 'nexus-battle-notifications',
      logLevel: 'info',
      healthPort: 3001,
      ingestEnabled: false,
      ingestPort: 3002,
      ingestSharedSecret: null,
      emailDriver: 'fake',
      smtpUser: null,
      smtpPass: null,
      queueDriver: 'memory',
      queueUrl: null,
      catalogQueueDriver: 'memory',
      catalogQueueUrl: null,
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
      SMTP_USER: 'usuario',
      SMTP_PASS: 'clave',
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
      smtpUser: 'usuario',
      smtpPass: 'clave',
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

  describe('CATALOG_QUEUE_DRIVER (desacoplado de QUEUE_DRIVER, Infrastructure#93)', () => {
    it('caso A: ambos en memoria, sin exigir ninguna URL', () => {
      const config = loadConfig({ QUEUE_DRIVER: 'memory', CATALOG_QUEUE_DRIVER: 'memory' })

      expect(config.queueDriver).toBe('memory')
      expect(config.catalogQueueDriver).toBe('memory')
    })

    it('caso B: cola general en memoria y Catalog por SQS, sin exigir QUEUE_URL general', () => {
      const config = loadConfig({
        QUEUE_DRIVER: 'memory',
        CATALOG_QUEUE_DRIVER: 'sqs',
        CATALOG_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created',
        AWS_REGION: 'us-east-1',
      })

      expect(config.queueDriver).toBe('memory')
      expect(config.queueUrl).toBeNull()
      expect(config.catalogQueueDriver).toBe('sqs')
      expect(config.catalogQueueUrl).toBe(
        'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created',
      )
    })

    it('caso C: Catalog por SQS sin CATALOG_QUEUE_URL falla', () => {
      expect(() => loadConfig({ CATALOG_QUEUE_DRIVER: 'sqs', AWS_REGION: 'us-east-1' })).toThrow(
        /CATALOG_QUEUE_URL \(o CATALOG_EVENTS_QUEUE_URL\) es obligatorio/,
      )
    })

    it('acepta CATALOG_EVENTS_QUEUE_URL como alias de CATALOG_QUEUE_URL', () => {
      const config = loadConfig({
        CATALOG_QUEUE_DRIVER: 'sqs',
        CATALOG_EVENTS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created',
        AWS_REGION: 'us-east-1',
      })

      expect(config.catalogQueueUrl).toBe(
        'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created',
      )
    })

    it('caso D: Catalog por SQS sin AWS_REGION falla', () => {
      expect(() =>
        loadConfig({
          CATALOG_QUEUE_DRIVER: 'sqs',
          CATALOG_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created',
        }),
      ).toThrow(/AWS_REGION es obligatorio cuando CATALOG_QUEUE_DRIVER es "sqs"/)
    })

    it('caso E: QUEUE_DRIVER=sqs sin QUEUE_URL general sigue fallando igual que antes, sin relacion con Catalog', () => {
      expect(() =>
        loadConfig({
          QUEUE_DRIVER: 'sqs',
          AWS_REGION: 'us-east-1',
          CATALOG_QUEUE_DRIVER: 'memory',
        }),
      ).toThrow(/QUEUE_URL es obligatorio cuando QUEUE_DRIVER es "sqs"/)
    })

    it('queue general SQS + Catalog en memoria: cada driver se valida por su cuenta', () => {
      const config = loadConfig({
        QUEUE_DRIVER: 'sqs',
        QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/notificaciones',
        AWS_REGION: 'us-east-1',
        CATALOG_QUEUE_DRIVER: 'memory',
      })

      expect(config.queueDriver).toBe('sqs')
      expect(config.catalogQueueDriver).toBe('memory')
      expect(config.catalogQueueUrl).toBeNull()
    })

    it('ambas colas por SQS, con URLs independientes', () => {
      const config = loadConfig({
        QUEUE_DRIVER: 'sqs',
        QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/notificaciones',
        CATALOG_QUEUE_DRIVER: 'sqs',
        CATALOG_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created',
        AWS_REGION: 'us-east-1',
      })

      expect(config.queueUrl).toBe('https://sqs.us-east-1.amazonaws.com/1/notificaciones')
      expect(config.catalogQueueUrl).toBe(
        'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created',
      )
    })
  })

  it('activa la ingesta y lee su puerto y secreto', () => {
    const config = loadConfig({
      INGEST_ENABLED: 'true',
      INGEST_PORT: '4002',
      INGEST_SHARED_SECRET: 'secreto',
    })

    expect(config.ingestEnabled).toBe(true)
    expect(config.ingestPort).toBe(4002)
    expect(config.ingestSharedSecret).toBe('secreto')
  })

  /**
   * El choque de puertos solo importa si la ingesta esta encendida: apagada,
   * nadie escucha en `INGEST_PORT` y coincidir es inofensivo.
   */
  it('admite que los puertos coincidan si la ingesta esta apagada', () => {
    expect(() => loadConfig({ INGEST_ENABLED: 'false', INGEST_PORT: '3001' })).not.toThrow()
  })

  it.each([
    ['un valor fuera del catalogo', { LOG_LEVEL: 'verbose' }],
    ['un booleano que no es "true" ni "false"', { INGEST_ENABLED: '1' }],
    [
      'la ingesta compartiendo puerto con las sondas',
      { INGEST_ENABLED: 'true', INGEST_PORT: '3001', HEALTH_PORT: '3001' },
    ],
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

  describe('CATALOG_NOTIFICATIONS_HTTP_ENABLED (HU-38)', () => {
    const BASE = {
      CATALOG_NOTIFICATIONS_HTTP_ENABLED: 'true',
      MONGO_URL: 'mongodb://localhost:27017',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
    }

    it('desactivada por defecto', () => {
      expect(loadConfig({}).catalogNotifications).toBeNull()
    })

    it('activa con la configuracion minima y puerto por defecto', () => {
      const config = loadConfig(BASE)

      expect(config.catalogNotifications).toMatchObject({
        port: 3004,
        repositoryDriver: 'mongo',
        cognitoUserPoolId: 'us-east-1_pruebas',
        cognitoClientId: 'cliente-de-pruebas',
        lifecycleQueueUrl: null,
        lifecycleQueueDriver: 'memory',
      })
    })

    it('lee una cola de ciclo de vida dedicada cuando se define', () => {
      const config = loadConfig({
        ...BASE,
        CATALOG_LIFECYCLE_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/lifecycle',
      })

      expect(config.catalogNotifications?.lifecycleQueueUrl).toBe(
        'https://sqs.us-east-1.amazonaws.com/1/lifecycle',
      )
    })

    describe('CATALOG_LIFECYCLE_QUEUE_DRIVER (desacoplado de QUEUE_DRIVER y CATALOG_QUEUE_DRIVER, ADR-018/Infrastructure#95)', () => {
      const lifecycleUrl = 'https://sqs.us-east-1.amazonaws.com/1/catalog-lifecycle-notifications'

      it('caso 1: default memory aunque exista CATALOG_LIFECYCLE_QUEUE_URL (no se activa SQS por presencia accidental)', () => {
        const config = loadConfig({ ...BASE, CATALOG_LIFECYCLE_QUEUE_URL: lifecycleUrl })

        expect(config.catalogNotifications?.lifecycleQueueDriver).toBe('memory')
      })

      it('caso 2: sqs + URL + region carga correctamente', () => {
        const config = loadConfig({
          ...BASE,
          CATALOG_LIFECYCLE_QUEUE_DRIVER: 'sqs',
          CATALOG_LIFECYCLE_QUEUE_URL: lifecycleUrl,
          AWS_REGION: 'us-east-1',
        })

        expect(config.catalogNotifications?.lifecycleQueueDriver).toBe('sqs')
        expect(config.catalogNotifications?.lifecycleQueueUrl).toBe(lifecycleUrl)
      })

      it('caso 3: sqs sin CATALOG_LIFECYCLE_QUEUE_URL falla', () => {
        expect(() =>
          loadConfig({ ...BASE, CATALOG_LIFECYCLE_QUEUE_DRIVER: 'sqs', AWS_REGION: 'us-east-1' }),
        ).toThrow(/CATALOG_LIFECYCLE_QUEUE_URL es obligatorio/)
      })

      it('caso 4: sqs sin AWS_REGION falla', () => {
        expect(() =>
          loadConfig({
            ...BASE,
            CATALOG_LIFECYCLE_QUEUE_DRIVER: 'sqs',
            CATALOG_LIFECYCLE_QUEUE_URL: lifecycleUrl,
          }),
        ).toThrow(/AWS_REGION es obligatorio cuando CATALOG_LIFECYCLE_QUEUE_DRIVER es "sqs"/)
      })

      it('caso 5: general memory + created sqs + lifecycle sqs es una configuracion valida, con URLs independientes', () => {
        const config = loadConfig({
          ...BASE,
          QUEUE_DRIVER: 'memory',
          CATALOG_QUEUE_DRIVER: 'sqs',
          CATALOG_QUEUE_URL:
            'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created-notifications',
          CATALOG_LIFECYCLE_QUEUE_DRIVER: 'sqs',
          CATALOG_LIFECYCLE_QUEUE_URL: lifecycleUrl,
          AWS_REGION: 'us-east-1',
        })

        expect(config.queueDriver).toBe('memory')
        expect(config.catalogQueueDriver).toBe('sqs')
        expect(config.catalogQueueUrl).toBe(
          'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created-notifications',
        )
        expect(config.catalogNotifications?.lifecycleQueueDriver).toBe('sqs')
        expect(config.catalogNotifications?.lifecycleQueueUrl).toBe(lifecycleUrl)
      })

      it('caso 6: QUEUE_DRIVER=sqs general sin QUEUE_URL sigue fallando igual que antes', () => {
        expect(() => loadConfig({ ...BASE, QUEUE_DRIVER: 'sqs', AWS_REGION: 'us-east-1' })).toThrow(
          /QUEUE_URL es obligatorio cuando QUEUE_DRIVER es "sqs"/,
        )
      })

      it('caso 7: CATALOG_QUEUE_DRIVER=sqs sin CATALOG_QUEUE_URL sigue fallando igual que antes', () => {
        expect(() =>
          loadConfig({ ...BASE, CATALOG_QUEUE_DRIVER: 'sqs', AWS_REGION: 'us-east-1' }),
        ).toThrow(/CATALOG_QUEUE_URL \(o CATALOG_EVENTS_QUEUE_URL\) es obligatorio/)
      })

      it('caso 8: lifecycle memory no activa SQS aunque QUEUE_DRIVER y CATALOG_QUEUE_DRIVER generales sean sqs', () => {
        const config = loadConfig({
          ...BASE,
          QUEUE_DRIVER: 'sqs',
          QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/notificaciones',
          CATALOG_QUEUE_DRIVER: 'sqs',
          CATALOG_QUEUE_URL:
            'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created-notifications',
          CATALOG_LIFECYCLE_QUEUE_DRIVER: 'memory',
          AWS_REGION: 'us-east-1',
        })

        expect(config.catalogNotifications?.lifecycleQueueDriver).toBe('memory')
        expect(config.catalogNotifications?.lifecycleQueueUrl).toBeNull()
      })
    })

    it('exige MONGO_URL cuando el driver es mongo', () => {
      expect(() =>
        loadConfig({ ...BASE, MONGO_URL: '', CATALOG_NOTIFICATIONS_REPOSITORY_DRIVER: 'mongo' }),
      ).toThrow(/MONGO_URL es obligatorio/)
    })

    it('exige COGNITO_USER_POOL_ID y COGNITO_CLIENT_ID', () => {
      expect(() => loadConfig({ ...BASE, COGNITO_USER_POOL_ID: '' })).toThrow(
        /COGNITO_USER_POOL_ID y COGNITO_CLIENT_ID son obligatorios/,
      )
      expect(() => loadConfig({ ...BASE, COGNITO_CLIENT_ID: '' })).toThrow(
        /COGNITO_USER_POOL_ID y COGNITO_CLIENT_ID son obligatorios/,
      )
    })

    it('rechaza un puerto que coincide con el de salud o el de compras', () => {
      expect(() => loadConfig({ ...BASE, CATALOG_NOTIFICATIONS_HTTP_PORT: '3001' })).toThrow(
        /debe ser distinto de los otros puertos/,
      )
      expect(() =>
        loadConfig({
          ...BASE,
          PURCHASE_HTTP_ENABLED: 'true',
          INTERNAL_SERVICE_AUTH_SECRET: 's',
          PURCHASE_INBOX_DRIVER: 'memory',
          CATALOG_NOTIFICATIONS_HTTP_PORT: '3003',
        }),
      ).toThrow(/debe ser distinto de los otros puertos/)
    })

    it('en produccion exige persistencia mongo', () => {
      expect(() =>
        loadConfig({
          ...BASE,
          NODE_ENV: 'production',
          CATALOG_NOTIFICATIONS_REPOSITORY_DRIVER: 'memory',
        }),
      ).toThrow(/requieren persistencia Mongo/)
    })

    it('acepta el driver en memoria fuera de produccion', () => {
      const config = loadConfig({
        ...BASE,
        MONGO_URL: '',
        CATALOG_NOTIFICATIONS_REPOSITORY_DRIVER: 'memory',
      })

      expect(config.catalogNotifications?.repositoryDriver).toBe('memory')
    })

    describe('playerInventory (HU-38, resolucion de destinatarios)', () => {
      it('null cuando falta PLAYER_INVENTORY_BASE_URL: fail closed, no bloquea el arranque', () => {
        const config = loadConfig({ ...BASE, INTERNAL_SERVICE_AUTH_SECRET: 's' })

        expect(config.catalogNotifications?.playerInventory).toBeNull()
      })

      it('null cuando falta INTERNAL_SERVICE_AUTH_SECRET aunque haya URL', () => {
        const config = loadConfig({
          ...BASE,
          PLAYER_INVENTORY_BASE_URL: 'http://player-inventory:3002',
        })

        expect(config.catalogNotifications?.playerInventory).toBeNull()
      })

      it('se activa con URL y secreto, con timeout por defecto', () => {
        const config = loadConfig({
          ...BASE,
          PLAYER_INVENTORY_BASE_URL: 'http://player-inventory:3002',
          INTERNAL_SERVICE_AUTH_SECRET: 'secreto-compartido',
        })

        expect(config.catalogNotifications?.playerInventory).toEqual({
          baseUrl: 'http://player-inventory:3002',
          secret: 'secreto-compartido',
          timeoutMs: 2_000,
        })
      })

      it('lee un timeout configurado', () => {
        const config = loadConfig({
          ...BASE,
          PLAYER_INVENTORY_BASE_URL: 'http://player-inventory:3002',
          INTERNAL_SERVICE_AUTH_SECRET: 'secreto-compartido',
          PLAYER_INVENTORY_TIMEOUT_MS: '5000',
        })

        expect(config.catalogNotifications?.playerInventory?.timeoutMs).toBe(5_000)
      })
    })
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
