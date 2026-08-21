import { RetryPolicy } from '../../../src/domain/policies/RetryPolicy.js'
import { DomainError } from '../../../src/domain/errors/DomainError.js'

const policy = RetryPolicy.create({ maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 10_000 })

describe('RetryPolicy', () => {
  it('expone el numero maximo de intentos', () => {
    expect(policy.maxAttempts).toBe(4)
  })

  it('reintenta mientras no se alcance el maximo', () => {
    expect(policy.shouldRetry(1, true)).toBe(true)
    expect(policy.shouldRetry(3, true)).toBe(true)
    expect(policy.shouldRetry(4, true)).toBe(false)
  })

  it('no reintenta un fallo permanente', () => {
    expect(policy.shouldRetry(1, false)).toBe(false)
  })

  it('aplica retroceso exponencial acotado', () => {
    expect(policy.delayForAttempt(1)).toBe(1_000)
    expect(policy.delayForAttempt(2)).toBe(2_000)
    expect(policy.delayForAttempt(3)).toBe(4_000)
    expect(policy.delayForAttempt(4)).toBe(8_000)
    expect(policy.delayForAttempt(5)).toBe(10_000)
    expect(policy.delayForAttempt(20)).toBe(10_000)
  })

  it('rechaza un numero de intento invalido', () => {
    expect(() => policy.delayForAttempt(0)).toThrow(DomainError)
    expect(() => policy.delayForAttempt(1.5)).toThrow(DomainError)
  })

  it.each([
    [{ maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 2 }],
    [{ maxAttempts: 1.5, baseDelayMs: 1, maxDelayMs: 2 }],
    [{ maxAttempts: 2, baseDelayMs: -1, maxDelayMs: 2 }],
    [{ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 10 }],
  ])('rechaza opciones invalidas %o', (options) => {
    expect(() => RetryPolicy.create(options)).toThrow(DomainError)
  })
})
