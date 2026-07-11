import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import {
  RECONNECT_GRACE_MS,
  ROOM_PAIRING_TTL_MS,
  type CreateRoomResponse,
  type JoinRoomResponse,
  type MessageDeliverEvent,
  type ImageMetadata,
} from '../../shared/protocol.js'
import { RoomError } from './errors.js'
import { RoomRepository } from './room-repository.js'
import type { DeviceSession, Room } from './types.js'

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const MAX_IMAGE_MEMORY_BYTES = 25 * 1024 * 1024

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function randomPairingCode(): string {
  const bytes = randomBytes(6)
  return Array.from(bytes, (byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join('')
}

function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export interface RoomServiceOptions {
  now?: () => number
  publicBaseUrl?: string
}

export class RoomService {
  private readonly now: () => number
  private readonly publicBaseUrl: string

  constructor(
    private readonly repository: RoomRepository,
    options: RoomServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.publicBaseUrl = options.publicBaseUrl ?? ''
  }

  createRoom(): CreateRoomResponse {
    const createdAt = this.now()
    const roomId = randomUUID()
    const pairingCode = this.createUniquePairingCode()
    const deviceToken = randomToken()
    const creator = this.createDevice(deviceToken, createdAt)
    const room: Room = {
      id: roomId,
      pairingCodeHash: digest(pairingCode),
      status: 'waiting',
      createdAt,
      pairingExpiresAt: createdAt + ROOM_PAIRING_TTL_MS,
      devices: new Map([[creator.id, creator]]),
      messages: [],
      images: new Map(),
    }

    this.repository.save(room)
    const joinPath = `/?room=${encodeURIComponent(roomId)}&code=${encodeURIComponent(pairingCode)}`
    return {
      roomId,
      pairingCode,
      deviceToken,
      expiresAt: room.pairingExpiresAt,
      joinUrl: this.publicBaseUrl ? new URL(joinPath, this.publicBaseUrl).toString() : joinPath,
    }
  }

  joinRoom(pairingCode: string): JoinRoomResponse {
    const normalizedCode = pairingCode.trim().toUpperCase()
    if (!normalizedCode) {
      throw new RoomError('PAIRING_CODE_INVALID', '配对码无效', 404)
    }

    const codeHash = digest(normalizedCode)
    const room = Array.from(this.repository.values()).find((candidate) =>
      hashesMatch(candidate.pairingCodeHash, codeHash),
    )

    if (!room) {
      throw new RoomError('PAIRING_CODE_INVALID', '配对码无效', 404)
    }
    if (room.pairingExpiresAt <= this.now()) {
      this.repository.delete(room.id)
      throw new RoomError('ROOM_EXPIRED', '房间已过期', 410)
    }
    if (room.devices.size >= 2 || room.status === 'paired') {
      throw new RoomError('ROOM_FULL', '房间已满', 409)
    }

    const deviceToken = randomToken()
    const device = this.createDevice(deviceToken, this.now())
    room.devices.set(device.id, device)
    room.status = 'paired'

    return { roomId: room.id, deviceToken, status: room.status }
  }

  authorize(roomId: string, deviceToken: string): { room: Room; device: DeviceSession } {
    const room = this.repository.get(roomId)
    const tokenHash = digest(deviceToken)
    const device = room
      ? Array.from(room.devices.values()).find((candidate) => hashesMatch(candidate.tokenHash, tokenHash))
      : undefined

    if (!room || !device || room.status === 'closing') {
      throw new RoomError('SESSION_UNAUTHORIZED', '会话凭据无效', 401)
    }
    return { room, device }
  }

  closeRoom(roomId: string, deviceToken: string): void {
    const { room } = this.authorize(roomId, deviceToken)
    room.status = 'closing'
    room.messages.length = 0
    room.images.clear()
    room.devices.clear()
    this.repository.delete(room.id)
  }

  markDisconnected(roomId: string, deviceToken: string): void {
    const { room, device } = this.authorize(roomId, deviceToken)
    device.connected = false
    device.lastSeenAt = this.now()
    if (Array.from(room.devices.values()).every((candidate) => !candidate.connected)) {
      room.disconnectExpiresAt = this.now() + RECONNECT_GRACE_MS
    }
  }

  markConnected(roomId: string, deviceToken: string): {
    room: Room
    device: DeviceSession
    peerOnline: boolean
  } {
    const { room, device } = this.authorize(roomId, deviceToken)
    device.connected = true
    device.lastSeenAt = this.now()
    room.disconnectExpiresAt = undefined
    const peerOnline = Array.from(room.devices.values()).some(
      (candidate) => candidate.id !== device.id && candidate.connected,
    )
    return { room, device, peerOnline }
  }

  addTextMessage(
    roomId: string,
    deviceToken: string,
    clientMessageId: string,
    text: string,
  ): { message: MessageDeliverEvent['message']; duplicate: boolean } {
    const { room, device } = this.authorize(roomId, deviceToken)
    const existing = room.messages.find((message) => message.clientMessageId === clientMessageId)
    if (existing) return { message: existing, duplicate: true }

    const message: MessageDeliverEvent['message'] = {
      id: randomUUID(),
      clientMessageId,
      senderDeviceId: device.id,
      kind: 'text',
      text,
      createdAt: this.now(),
    }
    room.messages.push(message)
    return { message, duplicate: false }
  }

  getMessage(roomId: string, deviceToken: string, clientMessageId: string): MessageDeliverEvent['message'] {
    const { room } = this.authorize(roomId, deviceToken)
    const message = room.messages.find((candidate) => candidate.clientMessageId === clientMessageId)
    if (!message) throw new RoomError('MESSAGE_NOT_FOUND', '消息不存在', 404)
    return message
  }

  addImage(roomId: string, deviceToken: string, metadata: ImageMetadata, bytes: Buffer): void {
    const { room } = this.authorize(roomId, deviceToken)
    const usedBytes = Array.from(this.repository.values()).reduce(
      (roomTotal, candidate) => roomTotal
        + Array.from(candidate.images.values()).reduce((total, image) => total + image.size, 0),
      0,
    )
    if (usedBytes + bytes.length > MAX_IMAGE_MEMORY_BYTES) {
      throw new RoomError('IMAGE_CAPACITY_EXCEEDED', '图片存储容量已达到上限', 413)
    }
    room.images.set(metadata.imageId, { ...metadata, bytes, createdAt: this.now() })
  }

  getImage(roomId: string, deviceToken: string, imageId: string): { metadata: ImageMetadata; bytes: Buffer } {
    const { room } = this.authorize(roomId, deviceToken)
    const image = room.images.get(imageId)
    if (!image) throw new RoomError('IMAGE_NOT_FOUND', '图片不存在', 404)
    const metadata: ImageMetadata = {
      imageId: image.imageId,
      fileName: image.fileName,
      mimeType: image.mimeType,
      size: image.size,
    }
    return { metadata, bytes: image.bytes }
  }

  addImageMessage(
    roomId: string,
    deviceToken: string,
    clientMessageId: string,
    image: ImageMetadata,
  ): { message: MessageDeliverEvent['message']; duplicate: boolean } {
    const { room, device } = this.authorize(roomId, deviceToken)
    const storedImage = room.images.get(image.imageId)
    if (
      !storedImage
      || storedImage.fileName !== image.fileName
      || storedImage.mimeType !== image.mimeType
      || storedImage.size !== image.size
    ) {
      throw new RoomError('IMAGE_NOT_FOUND', '图片不存在', 404)
    }
    const existing = room.messages.find((candidate) => candidate.clientMessageId === clientMessageId)
    if (existing) return { message: existing, duplicate: true }
    const message: MessageDeliverEvent['message'] = {
      id: randomUUID(),
      clientMessageId,
      senderDeviceId: device.id,
      kind: 'image',
      image,
      createdAt: this.now(),
    }
    room.messages.push(message)
    return { message, duplicate: false }
  }

  cleanupExpired(): string[] {
    const now = this.now()
    const removed: string[] = []
    for (const room of this.repository.values()) {
      const pairingExpired = room.status === 'waiting' && room.pairingExpiresAt <= now
      const disconnectExpired = room.disconnectExpiresAt !== undefined && room.disconnectExpiresAt <= now
      if (pairingExpired || disconnectExpired || room.status === 'closing') {
        room.messages.length = 0
        room.images.clear()
        room.devices.clear()
        this.repository.delete(room.id)
        removed.push(room.id)
      }
    }
    return removed
  }

  private createDevice(deviceToken: string, now: number): DeviceSession {
    return {
      id: randomUUID(),
      tokenHash: digest(deviceToken),
      connected: false,
      lastSeenAt: now,
    }
  }

  private createUniquePairingCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = randomPairingCode()
      const codeHash = digest(code)
      const exists = Array.from(this.repository.values()).some((room) =>
        hashesMatch(room.pairingCodeHash, codeHash),
      )
      if (!exists) return code
    }
    throw new Error('Unable to allocate a unique pairing code')
  }
}
