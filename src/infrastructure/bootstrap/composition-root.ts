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

  const catalogQueue: MessageQueuePort =
    config.queueDriver === QueueDriver.Sqs && config.catalogQueueUrl
      ? new SqsMessageQueue({
          client: SqsMessageQueue.createClient(config.awsRegion ?? ''),
          queueUrl: config.catalogQueueUrl,
          deadLetterQueueUrl: config.deadLetterQueueUrl,
        })
      : queue

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

  return { config, logger, queue, inMemoryQueue, consumer, catalogEventsConsumer, idempotencyStore }
}
