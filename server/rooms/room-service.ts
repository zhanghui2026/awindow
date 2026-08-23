import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import {
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  RECONNECT_GRACE_MS,
  ROOM_PAIRING_TTL_MS,
  VERIFICATION_TTL_MS,
  type CreateRoomResponse,
  type DeviceRole,
  type EncryptedEnvelope,
  type EncryptedTransferRecord,
  type JoinRoomResponse,
  type KeyExchangeEvent,
  type VerificationStatus,
} from '../../shared/protocol.js'
import { RoomError } from './errors.js'
import { RoomRepository } from './room-repository.js'
import type { DeviceSession, EncryptedImageAsset, Room } from './types.js'

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
    const creator = this.createDevice(deviceToken, 'creator', createdAt)
    const room: Room = {
      id: roomId,
      pairingCodeHash: digest(pairingCode),
      status: 'waiting',
      createdAt,
      pairingExpiresAt: createdAt + ROOM_PAIRING_TTL_MS,
      devices: new Map([[creator.id, creator]]),
      messages: [],
      images: new Map(),
      keyExchanges: new Map(),
      verificationStatus: 'pending',
      verificationConfirmations: new Set(),
      iceCandidateCount: 0,
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
    const joinedAt = this.now()
    const device = this.createDevice(deviceToken, 'joiner', joinedAt)
    room.devices.set(device.id, device)
    room.status = 'paired'
    room.verificationExpiresAt = joinedAt + VERIFICATION_TTL_MS

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
    room.keyExchanges.clear()
    room.verificationConfirmations.clear()
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

  addEncryptedMessage(
    roomId: string,
    deviceToken: string,
    envelope: EncryptedEnvelope,
  ): { message: EncryptedTransferRecord; duplicate: boolean } {
    const { room, device } = this.authorize(roomId, deviceToken)
    if (room.verificationStatus !== 'verified') {
      throw new RoomError('VERIFICATION_REQUIRED', '加密会话尚未验证', 409)
    }
    const existing = room.messages.find((message) =>
      message.senderDeviceId === device.id && message.envelope.messageId === envelope.messageId,
    )
    if (existing) {
      if (!this.envelopesEqual(existing.envelope, envelope)) {
        throw new RoomError('MESSAGE_CONFLICT', '消息标识已被其他密文使用', 409)
      }
      return { message: this.toTransferRecord(existing), duplicate: true }
    }

    const message: EncryptedTransferRecord & { senderDeviceId: string } = {
      id: randomUUID(),
      senderDeviceId: device.id,
      senderRole: device.role,
      envelope,
      createdAt: this.now(),
    }
    room.messages.push(message)
    return { message: this.toTransferRecord(message), duplicate: false }
  }

  getMessage(roomId: string, deviceToken: string, messageId: string): EncryptedTransferRecord {
    const { room, device } = this.authorize(roomId, deviceToken)
    const message = room.messages.find((candidate) =>
      candidate.senderDeviceId === device.id && candidate.envelope.messageId === messageId,
    )
    if (!message) throw new RoomError('MESSAGE_NOT_FOUND', '消息不存在', 404)
    return this.toTransferRecord(message)
  }

  addEncryptedImage(
    roomId: string,
    deviceToken: string,
    transferId: string,
    imageId: string,
    bytes: Buffer,
  ): { image: EncryptedImageAsset; duplicate: boolean } {
    const { room, device } = this.authorize(roomId, deviceToken)
    if (room.verificationStatus !== 'verified') {
      throw new RoomError('VERIFICATION_REQUIRED', '加密会话尚未验证', 409)
    }
    const existing = Array.from(room.images.values()).find((image) =>
      image.senderDeviceId === device.id && image.transferId === transferId,
    )
    if (existing) {
      if (!existing.bytes.equals(bytes)) {
        throw new RoomError('IMAGE_CONFLICT', '图片传输标识已被其他密文使用', 409)
      }
      return { image: existing, duplicate: true }
    }
    const usedBytes = Array.from(this.repository.values()).reduce(
      (roomTotal, candidate) => roomTotal
        + Array.from(candidate.images.values()).reduce((total, image) => total + image.bytes.length, 0),
      0,
    )
    if (usedBytes + bytes.length > MAX_IMAGE_MEMORY_BYTES) {
      throw new RoomError('IMAGE_CAPACITY_EXCEEDED', '图片存储容量已达到上限', 413)
    }
    const image = { imageId, transferId, senderDeviceId: device.id, bytes, createdAt: this.now() }
    room.images.set(imageId, image)
    return { image, duplicate: false }
  }

  getOwnEncryptedImage(
    roomId: string,
    deviceToken: string,
    transferId: string,
    imageId: string,
  ): EncryptedImageAsset {
    const { room, device } = this.authorize(roomId, deviceToken)
    const image = room.images.get(imageId)
    if (!image || image.senderDeviceId !== device.id || image.transferId !== transferId) {
      throw new RoomError('IMAGE_NOT_FOUND', '图片不存在', 404)
    }
    return image
  }

  getEncryptedImage(roomId: string, deviceToken: string, imageId: string): Buffer {
    const { room } = this.authorize(roomId, deviceToken)
    const image = room.images.get(imageId)
    if (!image) throw new RoomError('IMAGE_NOT_FOUND', '图片不存在', 404)
    return image.bytes
  }

  exchangeKey(roomId: string, deviceToken: string, publicKey: string, proof?: string): KeyExchangeEvent {
    const { room, device } = this.authorize(roomId, deviceToken)
    if (room.verificationStatus !== 'pending') throw new RoomError('VERIFICATION_CLOSED', '加密验证已结束', 409)
    const event: KeyExchangeEvent = { type: 'key.exchange', senderRole: device.role, publicKey, ...(proof ? { proof } : {}) }
    room.keyExchanges.set(device.role, event)
    room.verificationConfirmations.clear()
    return event
  }

  confirmVerification(roomId: string, deviceToken: string, matched: boolean): VerificationStatus {
    const { room, device } = this.authorize(roomId, deviceToken)
    if (room.verificationStatus !== 'pending') return room.verificationStatus
    if (!matched) {
      room.verificationStatus = 'failed'
      return room.verificationStatus
    }
    if (room.keyExchanges.size < 2) throw new RoomError('KEY_EXCHANGE_REQUIRED', '双方尚未完成密钥交换', 409)
    room.verificationConfirmations.add(device.role)
    if (room.verificationConfirmations.size === 2) {
      room.verificationStatus = 'verified'
      room.verificationExpiresAt = undefined
    }
    return room.verificationStatus
  }

  startNegotiation(roomId: string, deviceToken: string, negotiationId: string): void {
    const { room, device } = this.authorize(roomId, deviceToken)
    this.requireRole(device.role, 'creator')
    this.requireVerified(room.verificationStatus)
    room.negotiationId = negotiationId
    room.iceCandidateCount = 0
  }

  acceptAnswer(roomId: string, deviceToken: string, negotiationId: string): void {
    const { room, device } = this.authorize(roomId, deviceToken)
    this.requireRole(device.role, 'joiner')
    this.requireVerified(room.verificationStatus)
    if (room.negotiationId !== negotiationId) throw new RoomError('WEBRTC_SIGNAL_INVALID', 'WebRTC 协商标识无效', 400)
  }

  consumeIceCandidate(roomId: string, deviceToken: string, negotiationId: string): void {
    const { room } = this.authorize(roomId, deviceToken)
    this.requireVerified(room.verificationStatus)
    if (room.negotiationId !== negotiationId) throw new RoomError('WEBRTC_SIGNAL_INVALID', 'WebRTC 协商标识无效', 400)
    if (room.iceCandidateCount >= MAX_ICE_CANDIDATES_PER_NEGOTIATION) {
      throw new RoomError('WEBRTC_SIGNAL_LIMIT', 'ICE 候选数量达到上限', 429)
    }
    room.iceCandidateCount += 1
  }

  cleanupExpired(): string[] {
    const now = this.now()
    const removed: string[] = []
    for (const room of this.repository.values()) {
      const pairingExpired = room.status === 'waiting' && room.pairingExpiresAt <= now
      const disconnectExpired = room.disconnectExpiresAt !== undefined && room.disconnectExpiresAt <= now
      const verificationExpired = room.verificationStatus === 'pending'
        && room.verificationExpiresAt !== undefined
        && room.verificationExpiresAt <= now
      if (pairingExpired || disconnectExpired || verificationExpired || room.status === 'closing') {
        room.messages.length = 0
        room.images.clear()
        room.keyExchanges.clear()
        room.verificationConfirmations.clear()
        room.devices.clear()
        this.repository.delete(room.id)
        removed.push(room.id)
      }
    }
    return removed
  }

  private createDevice(deviceToken: string, role: DeviceRole, now: number): DeviceSession {
    return {
      id: randomUUID(),
      role,
      tokenHash: digest(deviceToken),
      connected: false,
      lastSeenAt: now,
    }
  }

  private envelopesEqual(left: EncryptedEnvelope, right: EncryptedEnvelope): boolean {
    return left.version === right.version
      && left.keyGeneration === right.keyGeneration
      && left.messageId === right.messageId
      && left.nonce === right.nonce
      && left.ciphertext === right.ciphertext
  }

  private toTransferRecord(message: Room['messages'][number]): EncryptedTransferRecord {
    return {
      id: message.id,
      senderRole: message.senderRole,
      envelope: message.envelope,
      createdAt: message.createdAt,
    }
  }

  private requireRole(actual: DeviceRole, expected: DeviceRole): void {
    if (actual !== expected) throw new RoomError('WEBRTC_SIGNAL_INVALID', '设备角色无权发送此信令', 403)
  }

  private requireVerified(status: VerificationStatus): void {
    if (status !== 'verified') throw new RoomError('VERIFICATION_REQUIRED', '加密会话尚未验证', 409)
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
