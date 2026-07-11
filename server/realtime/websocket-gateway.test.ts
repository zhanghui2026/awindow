import { once } from 'node:events'

import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import type { CreateRoomResponse, JoinRoomResponse, ServerMessage } from '../../shared/protocol.js'
import { buildApp } from '../app.js'

interface TestSocket {
  socket: WebSocket
  next(type: ServerMessage['type']): Promise<ServerMessage>
}

async function connect(url: string): Promise<TestSocket> {
  const socket = new WebSocket(url)
  const queued: ServerMessage[] = []
  const waiting = new Map<ServerMessage['type'], ((message: ServerMessage) => void)[]>()
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as ServerMessage
    const resolver = waiting.get(message.type)?.shift()
    if (resolver) resolver(message)
    else queued.push(message)
  })
  await once(socket, 'open')
  return {
    socket,
    next(type) {
      const index = queued.findIndex((message) => message.type === type)
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0] as ServerMessage)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2_000)
        const resolver = (message: ServerMessage) => {
          clearTimeout(timer)
          resolve(message)
        }
        const resolvers = waiting.get(type) ?? []
        resolvers.push(resolver)
        waiting.set(type, resolvers)
      })
    },
  }
}

describe('WebSocket gateway', () => {
  const apps: FastifyInstance[] = []
  const sockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      if (socket.readyState === WebSocket.OPEN) socket.terminate()
    }
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  async function pairedFixture() {
    const app = await buildApp()
    apps.push(app)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    const httpBase = `http://127.0.0.1:${address.port}`
    const wsBase = `ws://127.0.0.1:${address.port}`

    const created = (await app.inject({ method: 'POST', url: '/api/rooms' }))
      .json<CreateRoomResponse>()
    const joined = (await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      payload: { pairingCode: created.pairingCode },
    })).json<JoinRoomResponse>()

    return { app, created, joined, httpBase, wsBase }
  }

  it('rejects invalid WebSocket credentials', async () => {
    const { created, wsBase } = await pairedFixture()
    const socket = new WebSocket(`${wsBase}/ws?roomId=${created.roomId}&deviceToken=invalid`)
    sockets.push(socket)

    const [, response] = await once(socket, 'unexpected-response') as [unknown, IncomingMessage]
    expect(response.statusCode).toBe(401)
    response.destroy()
  })

  it('delivers text once and acknowledges duplicate submissions', async () => {
    const { created, joined, wsBase } = await pairedFixture()
    const creator = await connect(
      `${wsBase}/ws?roomId=${created.roomId}&deviceToken=${created.deviceToken}`,
    )
    sockets.push(creator.socket)
    await creator.next('session.ready')

    const pairedEvent = creator.next('room.paired')
    const receiver = await connect(
      `${wsBase}/ws?roomId=${joined.roomId}&deviceToken=${joined.deviceToken}`,
    )
    sockets.push(receiver.socket)
    await receiver.next('session.ready')
    await pairedEvent

    const delivered = receiver.next('message.deliver')
    const acknowledged = creator.next('message.ack')
    creator.socket.send(JSON.stringify({
      type: 'text.send',
      clientMessageId: 'message-1',
      text: 'hello from desktop',
    }))

    expect(await acknowledged).toMatchObject({ type: 'message.ack', clientMessageId: 'message-1' })
    expect(await delivered).toMatchObject({
      type: 'message.deliver',
      message: { clientMessageId: 'message-1', text: 'hello from desktop' },
    })

    const duplicateAck = creator.next('message.ack')
    creator.socket.send(JSON.stringify({
      type: 'text.send',
      clientMessageId: 'message-1',
      text: 'hello from desktop',
    }))
    expect(await duplicateAck).toMatchObject({ clientMessageId: 'message-1' })
  })

  it('restores message history when a device reconnects', async () => {
    const { created, joined, wsBase } = await pairedFixture()
    const creator = await connect(
      `${wsBase}/ws?roomId=${created.roomId}&deviceToken=${created.deviceToken}`,
    )
    sockets.push(creator.socket)
    await creator.next('session.ready')
    const receiver = await connect(
      `${wsBase}/ws?roomId=${joined.roomId}&deviceToken=${joined.deviceToken}`,
    )
    sockets.push(receiver.socket)
    await receiver.next('session.ready')

    const delivered = receiver.next('message.deliver')
    creator.socket.send(JSON.stringify({
      type: 'text.send',
      clientMessageId: 'history-1',
      text: 'persist during session',
    }))
    await delivered
    receiver.socket.close()
    await once(receiver.socket, 'close')

    const reconnected = await connect(
      `${wsBase}/ws?roomId=${joined.roomId}&deviceToken=${joined.deviceToken}`,
    )
    sockets.push(reconnected.socket)
    const ready = await reconnected.next('session.ready')
    expect(ready).toMatchObject({
      type: 'session.ready',
      messages: [{ clientMessageId: 'history-1', text: 'persist during session' }],
    })
  })

  it('delivers uploaded image metadata once', async () => {
    const { app, created, joined, wsBase } = await pairedFixture()
    const upload = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/images`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
      payload: {
        fileName: 'photo.png',
        mimeType: 'image/png',
        bytes: Buffer.from('image-data').toString('base64'),
      },
    })
    expect(upload.statusCode).toBe(201)
    const image = upload.json<{
      imageId: string
      fileName: string
      mimeType: string
      size: number
    }>()

    const creator = await connect(
      `${wsBase}/ws?roomId=${created.roomId}&deviceToken=${created.deviceToken}`,
    )
    sockets.push(creator.socket)
    await creator.next('session.ready')
    const receiver = await connect(
      `${wsBase}/ws?roomId=${joined.roomId}&deviceToken=${joined.deviceToken}`,
    )
    sockets.push(receiver.socket)
    await receiver.next('session.ready')

    const delivered = receiver.next('message.deliver')
    const acknowledged = creator.next('message.ack')
    creator.socket.send(JSON.stringify({
      type: 'image.send',
      clientMessageId: 'image-message-1',
      image,
    }))

    expect(await acknowledged).toMatchObject({ clientMessageId: 'image-message-1' })
    expect(await delivered).toMatchObject({
      message: { kind: 'image', image: { imageId: image.imageId, fileName: 'photo.png' } },
    })

    const rejected = creator.next('error')
    creator.socket.send(JSON.stringify({
      type: 'image.send',
      clientMessageId: 'image-message-2',
      image: { ...image, imageId: 'missing-image' },
    }))
    expect(await rejected).toMatchObject({ error: { code: 'IMAGE_NOT_FOUND' } })
  })

  it('rate limits the sixty-first connection message in one minute', async () => {
    const { created, wsBase } = await pairedFixture()
    const creator = await connect(
      `${wsBase}/ws?roomId=${created.roomId}&deviceToken=${created.deviceToken}`,
    )
    sockets.push(creator.socket)
    await creator.next('session.ready')

    for (let index = 0; index < 60; index += 1) {
      const pong = creator.next('pong')
      creator.socket.send(JSON.stringify({ type: 'ping' }))
      await pong
    }
    const limited = creator.next('error')
    creator.socket.send(JSON.stringify({ type: 'ping' }))

    expect(await limited).toMatchObject({
      error: { code: 'RATE_LIMITED', retryAfterSeconds: 60 },
    })
  })
})
