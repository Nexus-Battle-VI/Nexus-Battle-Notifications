import { TemplateId } from '../../../src/domain/value-objects/TemplateId.js'
import { NotificationId } from '../../../src/domain/value-objects/NotificationId.js'
import { DomainError } from '../../../src/domain/errors/DomainError.js'

describe('TemplateId', () => {
  it('acepta kebab-case y normaliza', () => {
    expect(TemplateId.create('  Account-Welcome ').value).toBe('account-welcome')
  })

  it('compara por valor y se representa como texto', () => {
    const id = TemplateId.create('account-welcome')
    expect(id.equals(TemplateId.create('account-welcome'))).toBe(true)
    expect(id.equals(TemplateId.create('account-verification-code'))).toBe(false)
    expect(String(id)).toBe('account-welcome')
  })

  it.each([
    ['snake_case'],
    ['-inicia-con-guion'],
    ['termina-con-guion-'],
    [''],
    ['1-empieza-con-numero'],
  ])('rechaza "%s"', (raw) => {
    expect(() => TemplateId.create(raw)).toThrow(DomainError)
  })
})

describe('NotificationId', () => {
  it('normaliza espacios', () => {
    expect(NotificationId.create('  n-1 ').value).toBe('n-1')
  })

  it('compara por valor y se representa como texto', () => {
    expect(NotificationId.create('n-1').equals(NotificationId.create('n-1'))).toBe(true)
    expect(NotificationId.create('n-1').equals(NotificationId.create('n-2'))).toBe(false)
    expect(String(NotificationId.create('n-1'))).toBe('n-1')
  })

  it('rechaza un identificador vacio', () => {
    expect(() => NotificationId.create('   ')).toThrow(DomainError)
  })
})
