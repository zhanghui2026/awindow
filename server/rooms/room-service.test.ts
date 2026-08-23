import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  MAX_IMAGE_BYTES,
  RECONNECT_GRACE_MS,
  ROOM_PAIRING_TTL_MS,
  VERIFICATION_TTL_MS,
  type EncryptedEnvelope,
} from '../../shared/protocol.js'
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

function envelope(messageId: string, ciphertext = 'A'.repeat(22)): EncryptedEnvelope {
  return { version: 1, keyGeneration: 1, messageId, nonce: 'AAAAAAAAAAAAAAAA', ciphertext }
}

function verifyPair(service: RoomService, pairingCode: string, roomId: string, creatorToken: string) {
  const joined = service.joinRoom(pairingCode)
  service.exchangeKey(roomId, creatorToken, '{"kty":"EC","x":"creator"}', 'creator-proof')
  service.exchangeKey(roomId, joined.deviceToken, '{"kty":"EC","x":"joiner"}')
  service.confirmVerification(roomId, creatorToken, true)
  service.confirmVerification(roomId, joined.deviceToken, true)
  return joined
}

describe('RoomService', () => {
  it('creates a room with one authorized creator', () => {
    const { repository, service } = createFixture()
    const created = service.createRoom()

    expect(created.pairingCode).toHaveLength(6)
    expect(created.joinUrl).toContain('https://transfer.example.com/')
    expect(created.expiresAt).toBe(1_000 + ROOM_PAIRING_TTL_MS)
    expect(repository.get(created.roomId)?.devices.size).toBe(1)
    expect(service.authorize(created.roomId, created.deviceToken).device.role).toBe('creator')
    expect(repository.get(created.roomId)?.pairingCodeHash).not.toBe(created.pairingCode)
    expect(service.authorize(created.roomId, created.deviceToken).room.id).toBe(created.roomId)
  })

  it('pairs a second device and rejects a third device', () => {
    const { repository, service } = createFixture()
    const created = service.createRoom()
    const joined = service.joinRoom(created.pairingCode.toLowerCase())

    expect(joined.status).toBe('paired')
    expect(repository.get(created.roomId)?.devices.size).toBe(2)
    expect(service.authorize(joined.roomId, joined.deviceToken).device.role).toBe('joiner')
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

  it('stores exactly one encrypted message for repeated identifiers', () => {
    const { repository, service } = createFixture()
    const created = service.createRoom()

    verifyPair(service, created.pairingCode, created.roomId, created.deviceToken)
    for (let index = 0; index < 100; index += 1) {
      const clientMessageId = randomUUID()
      const first = service.addEncryptedMessage(
        created.roomId,
        created.deviceToken,
        envelope(clientMessageId),
      )
      const duplicate = service.addEncryptedMessage(
        created.roomId,
        created.deviceToken,
        envelope(clientMessageId),
      )

      expect(first.duplicate).toBe(false)
      expect(duplicate).toMatchObject({ duplicate: true, message: { id: first.message.id } })
    }

    expect(repository.get(created.roomId)?.messages).toHaveLength(100)
    expect(Object.keys(repository.get(created.roomId)?.messages[0] ?? {})).not.toEqual(
      expect.arrayContaining(['text', 'fileName', 'mimeType']),
    )
  })

  it('rejects ciphertext conflicts and unverified fallback content', () => {
    const { service } = createFixture()
    const created = service.createRoom()
    expect(() => service.addEncryptedMessage(created.roomId, created.deviceToken, envelope('message-1')))
      .toThrowError(RoomError)
    verifyPair(service, created.pairingCode, created.roomId, created.deviceToken)
    service.addEncryptedMessage(created.roomId, created.deviceToken, envelope('message-1'))
    expect(() => service.addEncryptedMessage(created.roomId, created.deviceToken, envelope('message-1', 'B'.repeat(22))))
      .toThrowError(RoomError)
  })

  it('clears image bytes when the room closes', () => {
    const { repository, service } = createFixture()
    const created = service.createRoom()
    const room = repository.get(created.roomId)
    verifyPair(service, created.pairingCode, created.roomId, created.deviceToken)
    service.addEncryptedImage(created.roomId, created.deviceToken, 'transfer-1', 'image-1', Buffer.from('test'))

    service.closeRoom(created.roomId, created.deviceToken)

    expect(room?.images.size).toBe(0)
  })

  it('enforces the process image memory capacity across rooms', () => {
    const { service } = createFixture()
    const first = service.createRoom()
    const second = service.createRoom()
    const fullImage = Buffer.alloc(MAX_IMAGE_BYTES)
    verifyPair(service, first.pairingCode, first.roomId, first.deviceToken)
    verifyPair(service, second.pairingCode, second.roomId, second.deviceToken)

    service.addEncryptedImage(first.roomId, first.deviceToken, 'transfer-1', 'image-1', fullImage)
    service.addEncryptedImage(second.roomId, second.deviceToken, 'transfer-2', 'image-2', fullImage)

    expect(() => service.addEncryptedImage(first.roomId, first.deviceToken, 'transfer-3', 'image-3', Buffer.alloc(6 * 1024 * 1024)))
      .toThrowError(RoomError)
  })

  it('stores one encrypted image for an identical sender transfer', () => {
    const { repository, service } = createFixture()
    const created = service.createRoom()
    const joined = verifyPair(service, created.pairingCode, created.roomId, created.deviceToken)
    const bytes = Buffer.from('ciphertext')

    const first = service.addEncryptedImage(created.roomId, created.deviceToken, 'transfer-1', 'image-1', bytes)
    const duplicate = service.addEncryptedImage(created.roomId, created.deviceToken, 'transfer-1', 'image-2', bytes)
    const peer = service.addEncryptedImage(created.roomId, joined.deviceToken, 'transfer-1', 'image-3', bytes)

    expect(first.duplicate).toBe(false)
    expect(duplicate).toMatchObject({ duplicate: true, image: { imageId: 'image-1' } })
    expect(peer.duplicate).toBe(false)
    expect(repository.get(created.roomId)?.images).toHaveLength(2)
    expect(() => service.addEncryptedImage(
      created.roomId,
      created.deviceToken,
      'transfer-1',
      'image-4',
      Buffer.from('other-ciphertext'),
    )).toThrowError(RoomError)
  })

  it('expires a paired room when verification times out', () => {
    const { advance, repository, service } = createFixture()
    const created = service.createRoom()
    service.joinRoom(created.pairingCode)
    advance(VERIFICATION_TTL_MS)
    expect(service.cleanupExpired()).toEqual([created.roomId])
    expect(repository.size).toBe(0)
  })

  it('limits ICE candidates within each negotiation round', () => {
    const { service } = createFixture()
    const created = service.createRoom()
    verifyPair(service, created.pairingCode, created.roomId, created.deviceToken)
    service.startNegotiation(created.roomId, created.deviceToken, 'round-1')
    for (let index = 0; index < MAX_ICE_CANDIDATES_PER_NEGOTIATION; index += 1) {
      service.consumeIceCandidate(created.roomId, created.deviceToken, 'round-1')
    }
    expect(() => service.consumeIceCandidate(created.roomId, created.deviceToken, 'round-1'))
      .toThrowError(RoomError)
  })
})
