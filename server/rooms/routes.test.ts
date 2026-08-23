import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'

describe('room HTTP routes', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  async function verifiedRoom(app: Awaited<ReturnType<typeof buildApp>>) {
    const created = (await app.inject({ method: 'POST', url: '/api/rooms' })).json<{
      roomId: string
      pairingCode: string
      deviceToken: string
    }>()
    const joined = (await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      payload: { pairingCode: created.pairingCode },
    })).json<{ deviceToken: string }>()
    const service = app.getDecorator<import('./room-service.js').RoomService>('roomService')
    service.exchangeKey(created.roomId, created.deviceToken, 'creator-key', 'proof')
    service.exchangeKey(created.roomId, joined.deviceToken, 'joiner-key')
    service.confirmVerification(created.roomId, created.deviceToken, true)
    service.confirmVerification(created.roomId, joined.deviceToken, true)
    return { ...created, joinerToken: joined.deviceToken }
  }

  it('creates, joins and closes a room', async () => {
    const app = await buildApp({ publicBaseUrl: 'https://transfer.example.com' })
    apps.push(app)

    const createResponse = await app.inject({ method: 'POST', url: '/api/rooms' })
    expect(createResponse.statusCode).toBe(201)
    const created = createResponse.json<{
      roomId: string
      pairingCode: string
      deviceToken: string
    }>()

    const joinResponse = await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      payload: { pairingCode: created.pairingCode },
    })
    expect(joinResponse.statusCode).toBe(200)
    expect(joinResponse.json()).toMatchObject({ roomId: created.roomId, status: 'paired' })

    const closeResponse = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${created.roomId}`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
    })
    expect(closeResponse.statusCode).toBe(204)
  })

  it('returns a structured error for invalid pairing codes', async () => {
    const app = await buildApp()
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      payload: { pairingCode: 'INVALID' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ code: 'PAIRING_CODE_INVALID', message: '配对码无效' })
  })

  it('does not reveal room existence for invalid session credentials', async () => {
    const app = await buildApp()
    apps.push(app)

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/rooms/unknown',
      headers: { authorization: 'Bearer invalid-token' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'SESSION_UNAUTHORIZED' })
  })

  it('returns ICE configuration only to an authorized room device', async () => {
    const webRtcConfig = {
      iceServers: [
        { urls: ['stun:stun.example.com'] },
        { urls: ['turns:turn.example.com'], username: 'device', credential: 'secret' },
      ],
      negotiationTimeoutMs: 8_000,
    }
    const app = await buildApp({ webRtcConfig })
    apps.push(app)
    const created = (await app.inject({ method: 'POST', url: '/api/rooms' })).json<{
      roomId: string
      deviceToken: string
    }>()

    const authorized = await app.inject({
      method: 'GET',
      url: `/api/webrtc/config?roomId=${created.roomId}`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
    })
    expect(authorized.statusCode).toBe(200)
    expect(authorized.json()).toEqual(webRtcConfig)

    const unauthorized = await app.inject({
      method: 'GET',
      url: `/api/webrtc/config?roomId=${created.roomId}`,
      headers: { authorization: 'Bearer invalid' },
    })
    expect(unauthorized.statusCode).toBe(401)
  })

  it('uploads and reads an authorized room image', async () => {
    const app = await buildApp()
    apps.push(app)
    const created = await verifiedRoom(app)
    const bytes = Buffer.from('test-image')
    const transferId = '12345678-1234-4123-8123-123456789abc'

    const upload = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/images`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
      payload: { transferId, bytes: bytes.toString('base64') },
    })
    expect(upload.statusCode).toBe(201)
    const image = upload.json<{ imageId: string; transferId: string; size: number; duplicate: boolean }>()
    expect(image.size).toBe(bytes.length)
    expect(image).toMatchObject({ transferId, duplicate: false })

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/images`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
      payload: { transferId, bytes: bytes.toString('base64') },
    })
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json()).toMatchObject({ imageId: image.imageId, transferId, duplicate: true })

    const read = await app.inject({
      method: 'GET',
      url: `/api/rooms/${created.roomId}/images/${image.imageId}`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
    })
    expect(read.statusCode).toBe(200)
    expect(read.headers['content-type']).toContain('application/octet-stream')
    expect(read.headers['content-disposition']).toBeUndefined()
    expect(read.rawPayload).toEqual(bytes)
  })

  it('rejects invalid and unauthorized encrypted image uploads', async () => {
    const app = await buildApp()
    apps.push(app)
    const created = await verifiedRoom(app)
    const payload = { bytes: '*invalid-base64*' }

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/images`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
      payload: { transferId: '12345678-1234-4123-8123-123456789abc', ...payload },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ code: 'ENCRYPTED_PAYLOAD_INVALID' })

    const unauthorized = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/images`,
      headers: { authorization: 'Bearer invalid' },
      payload: { transferId: '12345678-1234-4123-8123-123456789abc', bytes: 'dGVzdA==' },
    })
    expect(unauthorized.statusCode).toBe(401)
  })

  it('isolates images between rooms', async () => {
    const app = await buildApp()
    apps.push(app)
    const first = await verifiedRoom(app)
    const second = (await app.inject({ method: 'POST', url: '/api/rooms' })).json<{
      roomId: string
      deviceToken: string
    }>()
    const upload = await app.inject({
      method: 'POST',
      url: `/api/rooms/${first.roomId}/images`,
      headers: { authorization: `Bearer ${first.deviceToken}` },
      payload: { transferId: '12345678-1234-4123-8123-123456789abc', bytes: 'dGVzdA==' },
    })
    const { imageId } = upload.json<{ imageId: string }>()

    const crossRoomRead = await app.inject({
      method: 'GET',
      url: `/api/rooms/${first.roomId}/images/${imageId}`,
      headers: { authorization: `Bearer ${second.deviceToken}` },
    })
    expect(crossRoomRead.statusCode).toBe(401)
  })

  it('rate limits repeated invalid pairing attempts by source', async () => {
    const app = await buildApp()
    apps.push(app)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/rooms/join',
        payload: { pairingCode: 'INVALID' },
      })
      expect(response.statusCode).toBe(404)
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      payload: { pairingCode: 'INVALID' },
    })

    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 300 })
    expect(blocked.headers['retry-after']).toBe('300')
  })

  it('rate limits room creation by source', async () => {
    const app = await buildApp()
    apps.push(app)

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/rooms' })
      expect(response.statusCode).toBe(201)
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/rooms' })

    expect(blocked.statusCode).toBe(429)
    expect(blocked.headers['retry-after']).toBe('60')
  })

  it('adds security headers and stores only encrypted transfer content', async () => {
    const app = await buildApp()
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['x-frame-options']).toBe('DENY')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['permissions-policy']).toContain('camera=()')
    expect(response.headers['content-security-policy']).toContain("default-src 'self'")

    const created = await verifiedRoom(app)
    const roomService = app.getDecorator<import('./room-service.js').RoomService>('roomService')
    const result = roomService.addEncryptedMessage(created.roomId, created.deviceToken, {
      version: 1,
      keyGeneration: 1,
      messageId: 'encrypted-message',
      nonce: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'A'.repeat(22),
    })
    expect(Object.keys(result.message)).not.toEqual(expect.arrayContaining(['text', 'fileName', 'mimeType']))
    expect(result.message.envelope.ciphertext).toBe('A'.repeat(22))
  })
})
