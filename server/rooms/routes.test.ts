import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'

describe('room HTTP routes', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

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

  it('uploads and reads an authorized room image', async () => {
    const app = await buildApp()
    apps.push(app)
    const created = (await app.inject({ method: 'POST', url: '/api/rooms' })).json<{
      roomId: string
      deviceToken: string
    }>()
    const bytes = Buffer.from('test-image')

    const upload = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/images`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
      payload: { fileName: 'test.png', mimeType: 'image/png', bytes: bytes.toString('base64') },
    })
    expect(upload.statusCode).toBe(201)
    const image = upload.json<{ imageId: string; size: number }>()
    expect(image.size).toBe(bytes.length)

    const read = await app.inject({
      method: 'GET',
      url: `/api/rooms/${created.roomId}/images/${image.imageId}`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
    })
    expect(read.statusCode).toBe(200)
    expect(read.headers['content-type']).toContain('image/png')
    expect(read.rawPayload).toEqual(bytes)
  })

  it('rejects unsupported and unauthorized image uploads', async () => {
    const app = await buildApp()
    apps.push(app)
    const created = (await app.inject({ method: 'POST', url: '/api/rooms' })).json<{
      roomId: string
      deviceToken: string
    }>()
    const payload = { fileName: 'vector.svg', mimeType: 'image/svg+xml', bytes: 'dGVzdA==' }

    const unsupported = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/images`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
      payload,
    })
    expect(unsupported.statusCode).toBe(415)
    expect(unsupported.json()).toMatchObject({ code: 'IMAGE_TYPE_UNSUPPORTED' })

    const unauthorized = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/images`,
      headers: { authorization: 'Bearer invalid' },
      payload: { ...payload, mimeType: 'image/png' },
    })
    expect(unauthorized.statusCode).toBe(401)
  })

  it('rejects invalid image file names', async () => {
    const app = await buildApp()
    apps.push(app)
    const created = (await app.inject({ method: 'POST', url: '/api/rooms' })).json<{
      roomId: string
      deviceToken: string
    }>()

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/images`,
      headers: { authorization: `Bearer ${created.deviceToken}` },
      payload: { fileName: '   ', mimeType: 'image/png', bytes: 'dGVzdA==' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'IMAGE_METADATA_INVALID' })
  })

  it('isolates images between rooms', async () => {
    const app = await buildApp()
    apps.push(app)
    const first = (await app.inject({ method: 'POST', url: '/api/rooms' })).json<{
      roomId: string
      deviceToken: string
    }>()
    const second = (await app.inject({ method: 'POST', url: '/api/rooms' })).json<{
      roomId: string
      deviceToken: string
    }>()
    const upload = await app.inject({
      method: 'POST',
      url: `/api/rooms/${first.roomId}/images`,
      headers: { authorization: `Bearer ${first.deviceToken}` },
      payload: { fileName: 'private.png', mimeType: 'image/png', bytes: 'dGVzdA==' },
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

  it('adds security headers and preserves user-controlled text as data', async () => {
    const app = await buildApp()
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['x-frame-options']).toBe('DENY')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['permissions-policy']).toContain('camera=()')
    expect(response.headers['content-security-policy']).toContain("default-src 'self'")

    const created = (await app.inject({ method: 'POST', url: '/api/rooms' })).json<{
      roomId: string
      deviceToken: string
    }>()
    const roomService = app.getDecorator<import('./room-service.js').RoomService>('roomService')
    const text = '<img src=x onerror=alert(1)>'
    const result = roomService.addTextMessage(created.roomId, created.deviceToken, 'plain-text', text)
    expect(result.message.text).toBe(text)
  })
})
