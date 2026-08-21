import type { ClockPort } from '../../application/ports/ClockPort.js'

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date()
  }
}
