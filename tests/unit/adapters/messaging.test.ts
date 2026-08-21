import { InMemoryMessageQueue } from '../../../src/adapters/messaging/InMemoryMessageQueue.js'
import {
  InvalidMessageError,
  parseNotificationMessage,
} from '../../../src/adapters/messaging/NotificationMessageParser.js'

describe('InMemoryMessageQueue', () => {
  const buildQueue = (): { queue: InMemoryMessageQueue; advance: (ms: number) => void } => {
    let now = 1_000
    const queue = new InMemoryMessageQueue(() => now)

    return {
      queue,
      advance: (ms: number): void => {
        now += ms
      },
    }
  }

  it('entrega los mensajes publicados respetando el tamano del lote', async () => {
    const { queue } = buildQueue()
    queue.publish('a')
    queue.publish('b')
    queue.publish('c')

    const batch = await queue.receive(2)

    expect(batch).toHaveLength(2)
    expect(batch.map((m) => m.body)).toEqual(['a', 'b'])
    expect(queue.pendingCount).toBe(1)
    expect(queue.inFlightCount).toBe(2)
  })

  it('devuelve un lote vacio cuando el tamano no es valido', async () => {
    const { queue } = buildQueue()
    queue.publish('a')

    expect(await queue.receive(0)).toHaveLength(0)
    expect(queue.pendingCount).toBe(1)
  })

  it('elimina definitivamente un mensaje confirmado', async () => {
    const { queue } = buildQueue()
    queue.publish('a')

    const [message] = await queue.receive(1)
    await queue.acknowledge(message!.receiptHandle)

    expect(queue.inFlightCount).toBe(0)
    expect(queue.pendingCount).toBe(0)
    expect(await queue.receive(10)).toHaveLength(0)
  })

  it('oculta un mensaje reencolado hasta que vence el retraso', async () => {
    const { queue, advance } = buildQueue()
    queue.publish('a')

    const [first] = await queue.receive(1)
    await queue.requeue(first!.receiptHandle, 5_000)

    expect(await queue.receive(10)).toHaveLength(0)

    advance(5_000)
    const [second] = await queue.receive(10)

    expect(second?.body).toBe('a')
    expect(second?.receivedCount).toBe(2)
  })

  it('trata un retraso negativo como entrega inmediata', async () => {
    const { queue } = buildQueue()
    queue.publish('a')

    const [first] = await queue.receive(1)
    await queue.requeue(first!.receiptHandle, -1_000)

    expect(await queue.receive(10)).toHaveLength(1)
  })

  it('mueve a la cola de fallidos y registra el motivo', async () => {
    const { queue } = buildQueue()
    queue.publish('a')

    const [message] = await queue.receive(1)
    await queue.deadLetter(message!.receiptHandle, 'plantilla inexistente')

    expect(queue.deadLettered).toHaveLength(1)
    expect(queue.deadLettered[0]?.reason).toBe('plantilla inexistente')
    expect(queue.inFlightCount).toBe(0)
  })

  it('ignora operaciones sobre un recibo desconocido', async () => {
    const { queue } = buildQueue()

    await expect(queue.acknowledge('inexistente')).resolves.toBeUndefined()
    await expect(queue.requeue('inexistente', 10)).resolves.toBeUndefined()
    await expect(queue.deadLetter('inexistente', 'x')).resolves.toBeUndefined()
    expect(queue.deadLettered).toHaveLength(0)
  })
})

describe('parseNotificationMessage', () => {
  const valid = JSON.stringify({
    notificationId: 'n-1',
    recipient: 'jugador@nexus.test',
    templateId: 'account-welcome',
    variables: { displayName: 'Ana', intentos: 2, premium: true },
  })

  it('traduce un mensaje valido al comando de aplicacion', () => {
    expect(parseNotificationMessage(valid)).toEqual({
      notificationId: 'n-1',
      recipient: 'jugador@nexus.test',
      templateId: 'account-welcome',
      variables: { displayName: 'Ana', intentos: 2, premium: true },
    })
  })

  it('omite la clave de idempotencia cuando no viene informada', () => {
    const command = parseNotificationMessage(valid)

    expect(Object.hasOwn(command, 'idempotencyKey')).toBe(false)
  })

  it('conserva la clave de idempotencia cuando viene informada', () => {
    const body = JSON.stringify({
      notificationId: 'n-1',
      recipient: 'a@nexus.test',
      templateId: 'account-welcome',
      idempotencyKey: 'k-1',
    })

    expect(parseNotificationMessage(body).idempotencyKey).toBe('k-1')
  })

  it('ignora una clave de idempotencia vacia', () => {
    const body = JSON.stringify({
      notificationId: 'n-1',
      recipient: 'a@nexus.test',
      templateId: 'account-welcome',
      idempotencyKey: '   ',
    })

    expect(parseNotificationMessage(body).idempotencyKey).toBeUndefined()
  })

  it('usa un objeto vacio cuando no hay variables', () => {
    const body = JSON.stringify({
      notificationId: 'n-1',
      recipient: 'a@nexus.test',
      templateId: 'account-welcome',
      variables: null,
    })

    expect(parseNotificationMessage(body).variables).toEqual({})
  })

  it.each([
    ['no es JSON', 'esto-no-es-json'],
    ['es un arreglo', '[]'],
    ['es un escalar', '42'],
    ['omite notificationId', JSON.stringify({ recipient: 'a@nexus.test', templateId: 't' })],
    [
      'tiene notificationId vacio',
      JSON.stringify({ notificationId: '  ', recipient: 'a', templateId: 't' }),
    ],
    ['omite recipient', JSON.stringify({ notificationId: 'n-1', templateId: 't' })],
    ['omite templateId', JSON.stringify({ notificationId: 'n-1', recipient: 'a' })],
    [
      'trae variables como arreglo',
      JSON.stringify({ notificationId: 'n-1', recipient: 'a', templateId: 't', variables: [] }),
    ],
    [
      'trae una variable anidada',
      JSON.stringify({
        notificationId: 'n-1',
        recipient: 'a',
        templateId: 't',
        variables: { objeto: { profundo: true } },
      }),
    ],
  ])('rechaza un mensaje que %s', (_caso, body) => {
    expect(() => parseNotificationMessage(body)).toThrow(InvalidMessageError)
  })
})
