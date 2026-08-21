import nodemailer from 'nodemailer'

import { RetryPolicy } from '../../domain/policies/RetryPolicy.js'
import { SendTransactionalEmail } from '../../application/use-cases/SendTransactionalEmail.js'
import type { EmailSenderPort } from '../../application/ports/EmailSenderPort.js'
import { FakeEmailSender } from '../../adapters/email/FakeEmailSender.js'
import { SmtpEmailSender } from '../../adapters/email/SmtpEmailSender.js'
import { InMemoryTemplateRenderer } from '../../adapters/templates/InMemoryTemplateRenderer.js'
import { DEFAULT_TEMPLATES } from '../../adapters/templates/default-templates.js'
import { InMemoryMessageQueue } from '../../adapters/messaging/InMemoryMessageQueue.js'
import { NotificationConsumer } from '../../adapters/messaging/NotificationConsumer.js'
import { InMemoryIdempotencyStore } from '../../adapters/idempotency/InMemoryIdempotencyStore.js'
import { SystemClock } from '../../adapters/clock/SystemClock.js'
import { LoggingEventPublisher } from '../../adapters/events/LoggingEventPublisher.js'
import { createLogger, type Logger } from '../observability/logger.js'
import { type AppConfig, EmailDriver, QueueDriver } from '../config/env.js'
import { resolveSqsSettings } from '../aws/sqs-settings.js'

export interface Application {
  readonly config: AppConfig
  readonly logger: Logger
  readonly queue: InMemoryMessageQueue
  readonly consumer: NotificationConsumer
  readonly idempotencyStore: InMemoryIdempotencyStore
}

const buildEmailSender = (config: AppConfig): EmailSenderPort => {
  if (config.emailDriver === EmailDriver.Smtp) {
    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: false,
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

  if (config.queueDriver === QueueDriver.Sqs) {
    // La configuracion se valida ahora para que un despliegue mal parametrizado
    // falle al arrancar y no en el primer mensaje. El adaptador SQS permanece
    // sujeto a ADR-006: no se sustituye por una simulacion.
    const settings = resolveSqsSettings({ region: config.awsRegion, queueUrl: config.queueUrl })

    logger.warn('sqs_driver_not_available', {
      queueName: settings.queueName,
      region: settings.region,
      detail: 'El adaptador SQS requiere ADR-006 aprobado. Se usa la cola en memoria.',
    })
  }

  const clock = new SystemClock()
  const nowMs = (): number => clock.now().getTime()

  const queue = new InMemoryMessageQueue(nowMs)
  const idempotencyStore = new InMemoryIdempotencyStore(nowMs)

  const useCase = new SendTransactionalEmail({
    emailSender: buildEmailSender(config),
    templateRenderer: InMemoryTemplateRenderer.fromRecord(DEFAULT_TEMPLATES),
    idempotencyStore,
    eventPublisher: new LoggingEventPublisher(logger),
    clock,
    retryPolicy: RetryPolicy.create({
      maxAttempts: config.maxAttempts,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
    }),
    idempotencyTtlMs: config.idempotencyTtlMs,
  })

  const consumer = new NotificationConsumer({
    queue,
    useCase,
    logger,
    batchSize: config.batchSize,
  })

  return { config, logger, queue, consumer, idempotencyStore }
}
