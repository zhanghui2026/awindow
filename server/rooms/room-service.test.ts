import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { MAX_IMAGE_BYTES, RECONNECT_GRACE_MS, ROOM_PAIRING_TTL_MS } from '../../shared/protocol.js'
import { RoomError } from './errors.js'
import { RoomRepository } from './room-repository.js'
import { RoomService } from './room-service.js'

function createFixture() {
  let now = 1_000
  const repository = new RoomRepository()
  const service = new RoomService(repository, {
    now: () => now,
    publicBaseUrl: 'https://transfer.example.com',
  })
  return {
    repository,
    service,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
  }
}

describe('RoomService', () => {
  it('creates a room with one authorized creator', () => {
    const { repository, service } = createFixture()
    const created = service.createRoom()

    expect(created.pairingCode).toHaveLength(6)
    expect(created.joinUrl).toContain('https://transfer.example.com/')
    expect(created.expiresAt).toBe(1_000 + ROOM_PAIRING_TTL_MS)
    expect(repository.get(created.roomId)?.devices.size).toBe(1)
    expect(repository.get(created.roomId)?.pairingCodeHash).not.toBe(created.pairingCode)
    expect(service.authorize(created.roomId, created.deviceToken).room.id).toBe(created.roomId)
  })

  it('pairs a second device and rejects a third device', () => {
    const { repository, service } = createFixture()
    const created = service.createRoom()
    const joined = service.joinRoom(created.pairingCode.toLowerCase())

    expect(joined.status).toBe('paired')
    expect(repository.get(created.roomId)?.devices.size).toBe(2)
    expect(() => service.joinRoom(created.pairingCode)).toThrowError(RoomError)
    try {
      service.joinRoom(created.pairingCode)
    } catch (error) {
      expect((error as RoomError).code).toBe('ROOM_FULL')
    }
  })

  it('removes an expired waiting room', () => {
    const { advance, repository, service } = createFixture()
    const created = service.createRoom()

    advance(ROOM_PAIRING_TTL_MS)
    expect(service.cleanupExpired()).toEqual([created.roomId])
    expect(repository.size).toBe(0)
  })

  it('removes a room after the reconnect grace period', () => {
    const { advance, repository, service } = createFixture()
    const created = service.createRoom()
    service.markDisconnected(created.roomId, created.deviceToken)

    advance(RECONNECT_GRACE_MS - 1)
    expect(service.cleanupExpired()).toEqual([])
    advance(1)
    expect(service.cleanupExpired()).toEqual([created.roomId])
    expect(repository.size).toBe(0)
  })

  it('clears and removes a room when an authorized device closes it', () => {
    const { repository, service } = createFixture()
    const created = service.createRoom()

    service.closeRoom(created.roomId, created.deviceToken)
    expect(repository.get(created.roomId)).toBeUndefined()
  })

  it('stores exactly one message for repeated client identifiers', () => {
    const { repository, service } = createFixture()
    const created = service.createRoom()

    for (let index = 0; index < 100; index += 1) {
      const clientMessageId = randomUUID()
      const first = service.addTextMessage(
        created.roomId,
        created.deviceToken,
        clientMessageId,
        `message-${index}`,
      )
      const duplicate = service.addTextMessage(
        created.roomId,
        created.deviceToken,
        clientMessageId,
        `message-${index}`,
      )

      expect(first.duplicate).toBe(false)
      expect(duplicate).toMatchObject({ duplicate: true, message: { id: first.message.id } })
    }

    expect(repository.get(created.roomId)?.messages).toHaveLength(100)
  })

  it('clears image bytes when the room closes', () => {
    const { repository, service } = createFixture()
    const created = service.createRoom()
    const room = repository.get(created.roomId)
    service.addImage(created.roomId, created.deviceToken, {
      imageId: 'image-1',
      fileName: 'photo.png',
      mimeType: 'image/png',
      size: 4,
    }, Buffer.from('test'))

    service.closeRoom(created.roomId, created.deviceToken)

    expect(room?.images.size).toBe(0)
  })

  it('enforces the process image memory capacity across rooms', () => {
    const { service } = createFixture()
    const first = service.createRoom()
    const second = service.createRoom()
    const fullImage = Buffer.alloc(MAX_IMAGE_BYTES)

    service.addImage(first.roomId, first.deviceToken, {
      imageId: 'image-1',
      fileName: 'first.png',
      mimeType: 'image/png',
      size: fullImage.length,
    }, fullImage)
    service.addImage(second.roomId, second.deviceToken, {
      imageId: 'image-2',
      fileName: 'second.png',
      mimeType: 'image/png',
      size: fullImage.length,
    }, fullImage)

    expect(() => service.addImage(first.roomId, first.deviceToken, {
      imageId: 'image-3',
      fileName: 'overflow.png',
      mimeType: 'image/png',
      size: 6 * 1024 * 1024,
    }, Buffer.alloc(6 * 1024 * 1024))).toThrowError(RoomError)
  })
})
