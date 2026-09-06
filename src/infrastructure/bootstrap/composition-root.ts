import nodemailer from 'nodemailer'

import { RetryPolicy } from '../../domain/policies/RetryPolicy.js'
import { SendTransactionalEmail } from '../../application/use-cases/SendTransactionalEmail.js'
import { HandleCatalogProductCreated } from '../../application/use-cases/HandleCatalogProductCreated.js'
import type { EmailSenderPort } from '../../application/ports/EmailSenderPort.js'
import { FakeEmailSender } from '../../adapters/email/FakeEmailSender.js'
import { SmtpEmailSender } from '../../adapters/email/SmtpEmailSender.js'
import { InMemoryTemplateRenderer } from '../../adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../adapters/templates/default-templates.js'
import { SesEmailSender } from '../../adapters/email/SesEmailSender.js'
import { InMemoryMessageQueue } from '../../adapters/messaging/InMemoryMessageQueue.js'
import { NotificationConsumer } from '../../adapters/messaging/NotificationConsumer.js'
import { CatalogProductEventsConsumer } from '../../adapters/messaging/CatalogProductEventsConsumer.js'
import { SqsMessageQueue } from '../../adapters/messaging/SqsMessageQueue.js'
import type { MessageQueuePort } from '../../application/ports/MessageQueuePort.js'
import { InMemoryIdempotencyStore } from '../../adapters/idempotency/InMemoryIdempotencyStore.js'
import { SystemClock } from '../../adapters/clock/SystemClock.js'
import { LoggingEventPublisher } from '../../adapters/events/LoggingEventPublisher.js'
import { createLogger, type Logger } from '../observability/logger.js'
import { type AppConfig, EmailDriver, QueueDriver } from '../config/env.js'
import { resolveSqsSettings } from '../aws/sqs-settings.js'

export interface Application {
  readonly config: AppConfig
  readonly logger: Logger
  readonly queue: MessageQueuePort
  readonly inMemoryQueue: InMemoryMessageQueue | null
  readonly consumer: NotificationConsumer
  readonly catalogEventsConsumer: CatalogProductEventsConsumer
  /** Cola sobre la que corre `catalogEventsConsumer`. Expuesta para que HU-38 pueda montar un consumidor compuesto sobre el mismo mensaje sin duplicar la elección de cola. */
  readonly catalogQueue: MessageQueuePort
  /** Caso de uso de correo de `catalogEventsConsumer`, sin modificar. Expuesto por el mismo motivo que `catalogQueue`. */
  readonly catalogUseCase: HandleCatalogProductCreated
  readonly idempotencyStore: InMemoryIdempotencyStore
}

export const buildEmailSender = (config: AppConfig): EmailSenderPort => {
  if (config.emailDriver === EmailDriver.Ses) {
    // `loadConfig` ya garantiza que la region existe con este driver.
    return new SesEmailSender({
      client: SesEmailSender.createClient(config.awsRegion ?? ''),
      from: config.emailFrom,
    })
  }

  if (config.emailDriver === EmailDriver.Smtp) {
    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      ...(config.smtpUser === null || config.smtpPass === null
        ? {}
        : { auth: { user: config.smtpUser, pass: config.smtpPass } }),
    })

    return new SmtpEmailSender({ transport, from: config.emailFrom })
  }

  return new FakeEmailSender()
}

/**
 * Raiz de composicion: el unico lugar donde se eligen implementaciones
 * concretas. Ninguna capa interior conoce estas decisiones.
 */
export const buildApplication = (config: AppConfig): Application => {
  const logger = createLogger({
    level: config.logLevel,
    service: config.serviceName,
    version: config.version,
  })

  const clock = new SystemClock()
  const nowMs = (): number => clock.now().getTime()

  let queue: MessageQueuePort
  let inMemoryQueue: InMemoryMessageQueue | null = null

  if (config.queueDriver === QueueDriver.Sqs) {
    const settings = resolveSqsSettings({ region: config.awsRegion, queueUrl: config.queueUrl })
    logger.info('sqs_driver_initialized', {
      queueName: settings.queueName,
      region: settings.region,
    })

    queue = new SqsMessageQueue({
      client: SqsMessageQueue.createClient(config.awsRegion ?? ''),
      queueUrl: config.queueUrl ?? '',
      deadLetterQueueUrl: config.deadLetterQueueUrl,
    })
  } else {
    inMemoryQueue = new InMemoryMessageQueue(nowMs)
    queue = inMemoryQueue
  }

  /**
   * Cola dedicada de `catalog.product.created` (ADR-017, Infrastructure#93).
   *
   * Independiente de `queueDriver`/`queue`: antes, esta cola solo se activaba
   * cuando la cola GENERAL tambien era SQS, y si no, caia por defecto a
   * compartir la instancia de `queue` -que en modo SQS general habria sido la
   * cola equivocada, y en modo memoria general mezclaba el trafico de dos
   * consumidores en la misma cola en memoria-. `catalogQueueDriver` decide
   * esto por su cuenta: activar SQS para Catalog no exige la cola general, y
   * viceversa (ver el comentario de `catalogQueueDriver` en env.ts).
   *
   * Sin `deadLetterQueueUrl`, a proposito: no se reutiliza la DLQ general
   * -pertenece a otro dominio de mensajes y mezclarla violaria la DLQ propia
   * que Infrastructure#93 provisiona para esta cola-. Un mensaje
   * irreprocesable sigue entonces la redrive policy de la propia cola SQS
   * dedicada (`SqsMessageQueue.deadLetter` pone visibilidad a 0 hasta que
   * `ApproximateReceiveCount` alcanza el maximo), tal como exige ADR-017
   * seccion 5. Una DLQ dedicada a nivel de aplicacion (`CATALOG_DEAD_LETTER_QUEUE_URL`)
   * no existe todavia porque no hay un contrato aprobado para ella.
   */
  let catalogQueue: MessageQueuePort

  if (config.catalogQueueDriver === QueueDriver.Sqs) {
    const catalogSettings = resolveSqsSettings({
      region: config.awsRegion,
      queueUrl: config.catalogQueueUrl,
    })
    logger.info('catalog_sqs_driver_initialized', {
      queueName: catalogSettings.queueName,
      region: catalogSettings.region,
    })

    catalogQueue = new SqsMessageQueue({
      client: SqsMessageQueue.createClient(config.awsRegion ?? ''),
      queueUrl: config.catalogQueueUrl ?? '',
    })
  } else {
    catalogQueue = new InMemoryMessageQueue(nowMs)
  }

  const idempotencyStore = new InMemoryIdempotencyStore(nowMs)
  const emailSender = buildEmailSender(config)
  const templateRenderer = InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES)
  const eventPublisher = new LoggingEventPublisher(logger)
  const retryPolicy = RetryPolicy.create({
    maxAttempts: config.maxAttempts,
    baseDelayMs: config.retryBaseDelayMs,
    maxDelayMs: config.retryMaxDelayMs,
  })

  const useCase = new SendTransactionalEmail({
    emailSender,
    templateRenderer,
    idempotencyStore,
    eventPublisher,
    clock,
    retryPolicy,
    idempotencyTtlMs: config.idempotencyTtlMs,
  })

  const catalogUseCase = new HandleCatalogProductCreated({
    emailSender,
    templateRenderer,
    idempotencyStore,
    eventPublisher,
    clock,
    retryPolicy,
    idempotencyTtlMs: config.idempotencyTtlMs,
  })

  const consumer = new NotificationConsumer({
    queue,
    useCase,
    logger,
    batchSize: config.batchSize,
  })

  const catalogEventsConsumer = new CatalogProductEventsConsumer({
    queue: catalogQueue,
    useCase: catalogUseCase,
    logger,
    batchSize: config.batchSize,
  })

  return {
    config,
    logger,
    queue,
    inMemoryQueue,
    consumer,
    catalogEventsConsumer,
    catalogQueue,
    catalogUseCase,
    idempotencyStore,
  }
}
