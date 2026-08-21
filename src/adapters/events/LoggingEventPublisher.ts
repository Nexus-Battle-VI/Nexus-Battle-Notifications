import type { DomainEvent } from '../../domain/events/DomainEvent.js'
import type { EventPublisherPort } from '../../application/ports/EventPublisherPort.js'
import type { Logger } from '../../infrastructure/observability/logger.js'

/**
 * Publicador de eventos de dominio hacia la observabilidad.
 *
 * En Sprint 1 los eventos quedan trazados en el log estructurado. La
 * publicacion hacia un bus de eventos queda sujeta a ADR-006 y no se simula.
 */
export class LoggingEventPublisher implements EventPublisherPort {
  private readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.logger.info('domain_event', {
        event: event.name,
        aggregateId: event.aggregateId,
        occurredAt: event.occurredAt.toISOString(),
      })
    }

    return Promise.resolve()
  }
}
