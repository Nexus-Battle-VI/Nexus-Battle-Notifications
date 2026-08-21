import type { DomainEvent } from '../../domain/events/DomainEvent.js'

/**
 * Puerto de publicacion de eventos de dominio. En el alcance de Sprint 1 la
 * implementacion registra los eventos en la observabilidad; la publicacion
 * hacia un bus queda sujeta a ADR-006.
 */
export interface EventPublisherPort {
  publish(events: readonly DomainEvent[]): Promise<void>
}
