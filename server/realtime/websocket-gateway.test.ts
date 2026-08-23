import { once } from 'node:events'

import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import type {
  CreateRoomResponse,
  EncryptedEnvelope,
  JoinRoomResponse,
  ServerMessage,
} from '../../shared/protocol.js'
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

function envelope(messageId: string): EncryptedEnvelope {
  return {
    version: 1,
    keyGeneration: 1,
    messageId,
    nonce: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'A'.repeat(22),
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
    const wsBase = `ws://127.0.0.1:${address.port}`
    const created = (await app.inject({ method: 'POST', url: '/api/rooms' })).json<CreateRoomResponse>()
    const joined = (await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      payload: { pairingCode: created.pairingCode },
    })).json<JoinRoomResponse>()
    return { app, created, joined, wsBase }
  }

  async function connectedPair() {
    const fixture = await pairedFixture()
    const creator = await connect(`${fixture.wsBase}/ws?roomId=${fixture.created.roomId}&deviceToken=${fixture.created.deviceToken}`)
    sockets.push(creator.socket)
    const creatorReady = await creator.next('session.ready')
    const joiner = await connect(`${fixture.wsBase}/ws?roomId=${fixture.joined.roomId}&deviceToken=${fixture.joined.deviceToken}`)
    sockets.push(joiner.socket)
    const joinerReady = await joiner.next('session.ready')
    return { ...fixture, creator, joiner, creatorReady, joinerReady }
  }

  async function verifyPair(creator: TestSocket, joiner: TestSocket) {
    const joinerKey = joiner.next('key.exchange')
    creator.socket.send(JSON.stringify({ type: 'key.exchange', publicKey: 'creator-key', proof: 'creator-proof' }))
    expect(await joinerKey).toMatchObject({ senderRole: 'creator', publicKey: 'creator-key' })
    const creatorKey = creator.next('key.exchange')
    joiner.socket.send(JSON.stringify({ type: 'key.exchange', publicKey: 'joiner-key' }))
    expect(await creatorKey).toMatchObject({ senderRole: 'joiner', publicKey: 'joiner-key' })

    creator.socket.send(JSON.stringify({ type: 'verification.confirm', matched: true }))
    expect(await creator.next('verification.status')).toMatchObject({ status: 'pending' })
    expect(await joiner.next('verification.status')).toMatchObject({ status: 'pending' })
    joiner.socket.send(JSON.stringify({ type: 'verification.confirm', matched: true }))
    expect(await creator.next('verification.status')).toMatchObject({ status: 'verified' })
    expect(await joiner.next('verification.status')).toMatchObject({ status: 'verified' })
  }

  it('rejects invalid WebSocket credentials', async () => {
    const { created, wsBase } = await pairedFixture()
    const socket = new WebSocket(`${wsBase}/ws?roomId=${created.roomId}&deviceToken=invalid`)
    socket.on('error', () => undefined)
    const [, response] = await once(socket, 'unexpected-response') as [unknown, IncomingMessage]
    expect(response.statusCode).toBe(401)
    response.destroy()
    socket.terminate()
  })

  it('assigns stable roles and forwards key exchange only to the peer', async () => {
    const { creator, joiner, creatorReady, joinerReady } = await connectedPair()
    expect(creatorReady).toMatchObject({ type: 'session.ready', role: 'creator', verificationStatus: 'pending' })
    expect(joinerReady).toMatchObject({ type: 'session.ready', role: 'joiner', verificationStatus: 'pending' })
    await verifyPair(creator, joiner)
  })

  it('stores, delivers and restores only encrypted fallback messages', async () => {
    const { created, joined, wsBase, creator, joiner } = await connectedPair()
    await verifyPair(creator, joiner)
    const delivered = joiner.next('message.deliver')
    const acknowledged = creator.next('message.ack')
    creator.socket.send(JSON.stringify({ type: 'transfer.fallback', envelope: envelope('message-1') }))
    expect(await acknowledged).toMatchObject({ messageId: 'message-1' })
    expect(await delivered).toMatchObject({
      message: { senderRole: 'creator', envelope: { messageId: 'message-1', ciphertext: 'A'.repeat(22) } },
    })

    const duplicateAck = creator.next('message.ack')
    creator.socket.send(JSON.stringify({ type: 'transfer.fallback', envelope: envelope('message-1') }))
    expect(await duplicateAck).toMatchObject({ messageId: 'message-1' })

    joiner.socket.close()
    await once(joiner.socket, 'close')
    const reconnected = await connect(`${wsBase}/ws?roomId=${joined.roomId}&deviceToken=${joined.deviceToken}`)
    sockets.push(reconnected.socket)
    expect(await reconnected.next('session.ready')).toMatchObject({
      verificationStatus: 'verified',
      messages: [{ envelope: { messageId: 'message-1' } }],
    })
    expect(created.roomId).toBe(joined.roomId)
  })

  it('delivers an authorized HTTP image fallback reference', async () => {
    const { created, wsBase, creator, joiner, app } = await connectedPair()
    await verifyPair(creator, joiner)
    const transferId = '12345678-1234-4123-8123-123456789abc'
    const upload = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/images`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
      payload: { transferId, bytes: Buffer.from('encrypted-package').toString('base64') },
    })
    expect(upload.statusCode).toBe(201)
    const image = upload.json<{ imageId: string }>()
    const delivered = joiner.next('image.deliver')
    creator.socket.send(JSON.stringify({ type: 'image.fallback', transferId, imageId: image.imageId }))
    expect(await delivered).toMatchObject({
      transferId,
      imageId: image.imageId,
      senderRole: 'creator',
    })
    expect(wsBase).toContain('ws://')
  })

  it('enforces offer and answer roles while forwarding valid WebRTC signals', async () => {
    const { creator, joiner } = await connectedPair()
    await verifyPair(creator, joiner)
    const offer = joiner.next('webrtc.offer')
    creator.socket.send(JSON.stringify({
      type: 'webrtc.offer',
      negotiationId: 'round-1',
      description: { type: 'offer', sdp: 'v=0 creator-offer' },
    }))
    expect(await offer).toMatchObject({ senderRole: 'creator', negotiationId: 'round-1' })

    const rejected = joiner.next('error')
    joiner.socket.send(JSON.stringify({
      type: 'webrtc.offer',
      negotiationId: 'round-2',
      description: { type: 'offer', sdp: 'v=0 invalid-offer' },
    }))
    expect(await rejected).toMatchObject({ error: { code: 'WEBRTC_SIGNAL_INVALID' } })

    const answer = creator.next('webrtc.answer')
    joiner.socket.send(JSON.stringify({
      type: 'webrtc.answer',
      negotiationId: 'round-1',
      description: { type: 'answer', sdp: 'v=0 joiner-answer' },
    }))
    expect(await answer).toMatchObject({ senderRole: 'joiner', negotiationId: 'round-1' })
  })

  it('forwards ICE candidates for the active negotiation', async () => {
    const { creator, joiner } = await connectedPair()
    await verifyPair(creator, joiner)
    creator.socket.send(JSON.stringify({
      type: 'webrtc.offer',
      negotiationId: 'round-1',
      description: { type: 'offer', sdp: 'v=0' },
    }))
    await joiner.next('webrtc.offer')
    const ice = joiner.next('webrtc.ice')
    creator.socket.send(JSON.stringify({
      type: 'webrtc.ice',
      negotiationId: 'round-1',
      candidate: { candidate: 'candidate:1', sdpMLineIndex: 0 },
    }))
    expect(await ice).toMatchObject({ senderRole: 'creator', candidate: { candidate: 'candidate:1' } })
  })

  it('rate limits the sixty-first connection message in one minute', async () => {
    const { creator } = await connectedPair()
    for (let index = 0; index < 60; index += 1) {
      const pong = creator.next('pong')
      creator.socket.send(JSON.stringify({ type: 'ping' }))
      await pong
    }
    const limited = creator.next('error')
    creator.socket.send(JSON.stringify({ type: 'ping' }))
    expect(await limited).toMatchObject({ error: { code: 'RATE_LIMITED', retryAfterSeconds: 60 } })
  })
})
