import {
  MAX_FILE_NAME_LENGTH,
  MAX_IMAGE_BYTES,
  isSupportedImageType,
  validateEncryptedEnvelope,
  validateText,
  type DeviceRole,
  type EncryptedEnvelope,
  type EncryptedTransferRecord,
} from '../../shared/protocol.js'
import { CryptoSession, padBytes, padTextBytes, unpadBytes } from './crypto-session.js'

export const IMAGE_CHUNK_BYTES = 32 * 1024
export const IMAGE_PADDED_CHUNK_BYTES = 64 * 1024
const IMAGE_BINARY_HEADER_BYTES = 32
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

interface TextPayload {
  type: 'text'
  messageId: string
  text: string
}

interface AckPayload {
  type: 'ack'
  messageId: string
  acknowledgedMessageId: string
}

interface PartialImageState {
  transferId: string
  receivedChunks: number[]
}

interface ResumePayload {
  type: 'resume'
  messageId: string
  confirmedMessageIds: string[]
  partialImages: PartialImageState[]
}

interface ImageStartPayload {
  type: 'image.start'
  messageId: string
  transferId: string
  fileName: string
  mimeType: string
  size: number
  chunkCount: number
  sha256: string
}

interface ImageCompletePayload {
  type: 'image.complete'
  messageId: string
  transferId: string
}

type PlainPayload = TextPayload | AckPayload | ImageStartPayload | ImageCompletePayload | ResumePayload

export interface TransferTextEvent {
  id: string
  senderRole: DeviceRole
  messageId: string
  text: string
  createdAt: number
}

export interface TransferImageEvent {
  id: string
  senderRole: DeviceRole
  messageId: string
  fileName: string
  mimeType: string
  bytes: Uint8Array<ArrayBuffer>
  createdAt: number
}

export interface TransferImageProgressEvent {
  messageId: string
  transferredBytes: number
  totalBytes: number
  direction: 'sending' | 'receiving'
}

export interface TransferProtocolOptions {
  cryptoSession: CryptoSession
  sendDirect: (frame: string) => boolean
  sendDirectBinary?: (frame: ArrayBuffer) => Promise<boolean>
  sendFallback: (envelope: EncryptedEnvelope) => boolean
  sendImageFallback?: (transferId: string, bytes: Uint8Array<ArrayBuffer>) => Promise<void>
  onText: (event: TransferTextEvent) => void
  onImage?: (event: TransferImageEvent) => void
  onImageProgress?: (event: TransferImageProgressEvent) => void
  onError?: (error: Error) => void
  persistCryptoSession?: () => Promise<void>
  acknowledgementTimeoutMs?: number
  createMessageId?: () => string
}

interface PendingText {
  envelope: EncryptedEnvelope
  frame: string
  timer?: number
  attempts: number
}

interface PendingImage {
  transferId: string
  bytes: Uint8Array<ArrayBuffer>
  timer?: number
  fallbackStarted: boolean
}

interface ReceivedFrame {
  envelopeFingerprint: string
  payload: PlainPayload
}

interface IncomingImage {
  senderRole: DeviceRole
  metadata: ImageStartPayload
  keyGeneration: number
  chunks: Map<number, Uint8Array<ArrayBuffer>>
  receivedBytes: number
  createdAt: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0))
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function uuidToBytes(value: string): Uint8Array<ArrayBuffer> {
  const compact = value.replaceAll('-', '')
  if (!UUID_PATTERN.test(value)) throw new Error('Image transfer identifier must be a UUID')
  return Uint8Array.from(compact.match(/.{2}/gu) ?? [], byte => Number.parseInt(byte, 16))
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function encodeImageChunkFrame(transferId: string, chunkIndex: number, envelope: EncryptedEnvelope): ArrayBuffer {
  if (envelope.messageId !== `${transferId}:${chunkIndex}`) throw new Error('Image chunk envelope does not match its header')
  const nonce = base64UrlToBytes(envelope.nonce)
  const ciphertext = base64UrlToBytes(envelope.ciphertext)
  const frame = new Uint8Array(IMAGE_BINARY_HEADER_BYTES + ciphertext.length)
  frame.set(uuidToBytes(transferId), 0)
  new DataView(frame.buffer).setUint32(16, chunkIndex)
  frame.set(nonce, 20)
  frame.set(ciphertext, IMAGE_BINARY_HEADER_BYTES)
  return frame.buffer
}

function parseImageChunkFrame(value: unknown, keyGeneration: number): { transferId: string; chunkIndex: number; envelope: EncryptedEnvelope } | undefined {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : undefined
  if (!bytes || bytes.length !== IMAGE_BINARY_HEADER_BYTES + IMAGE_PADDED_CHUNK_BYTES + 16) return undefined
  const transferId = bytesToUuid(bytes.subarray(0, 16))
  const chunkIndex = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16)
  return {
    transferId,
    chunkIndex,
    envelope: {
      version: 1,
      keyGeneration,
      messageId: `${transferId}:${chunkIndex}`,
      nonce: bytesToBase64Url(bytes.subarray(20, 32)),
      ciphertext: bytesToBase64Url(bytes.subarray(32)),
    },
  }
}

function encodeImageFallbackPackage(
  metadata: EncryptedEnvelope,
  chunks: ArrayBuffer[],
  complete: EncryptedEnvelope,
): Uint8Array<ArrayBuffer> {
  const metadataBytes = encoder.encode(JSON.stringify(metadata))
  const completeBytes = encoder.encode(JSON.stringify(complete))
  const chunkBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const output = new Uint8Array(12 + metadataBytes.length + chunkBytes + completeBytes.length)
  const view = new DataView(output.buffer)
  view.setUint32(0, metadataBytes.length)
  view.setUint32(4, chunks.length)
  view.setUint32(8, completeBytes.length)
  let offset = 12
  output.set(metadataBytes, offset)
  offset += metadataBytes.length
  for (const chunk of chunks) {
    output.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  }
  output.set(completeBytes, offset)
  return output
}

function parseImageFallbackPackage(bytes: ArrayBuffer): {
  metadata: EncryptedEnvelope
  chunks: ArrayBuffer[]
  complete: EncryptedEnvelope
} {
  if (bytes.byteLength < 12) throw new Error('Invalid encrypted image fallback')
  const view = new DataView(bytes)
  const metadataLength = view.getUint32(0)
  const chunkCount = view.getUint32(4)
  const completeLength = view.getUint32(8)
  const chunkLength = IMAGE_BINARY_HEADER_BYTES + IMAGE_PADDED_CHUNK_BYTES + 16
  const expectedLength = 12 + metadataLength + chunkCount * chunkLength + completeLength
  if (bytes.byteLength !== expectedLength) throw new Error('Invalid encrypted image fallback')
  const data = new Uint8Array(bytes)
  let offset = 12
  const parseEnvelope = (value: Uint8Array<ArrayBuffer>): EncryptedEnvelope => {
    const parsed = JSON.parse(decoder.decode(value)) as unknown
    if (validateEncryptedEnvelope(parsed)) throw new Error('Invalid encrypted image fallback')
    return parsed as EncryptedEnvelope
  }
  const metadata = parseEnvelope(data.slice(offset, offset + metadataLength))
  offset += metadataLength
  const chunks: ArrayBuffer[] = []
  for (let index = 0; index < chunkCount; index += 1) {
    chunks.push(data.slice(offset, offset + chunkLength).buffer)
    offset += chunkLength
  }
  const complete = parseEnvelope(data.slice(offset, offset + completeLength))
  return { metadata, chunks, complete }
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

function peerRole(role: DeviceRole): DeviceRole {
  return role === 'creator' ? 'joiner' : 'creator'
}

function envelopeFingerprint(envelope: EncryptedEnvelope): string {
  return `${envelope.version}\0${envelope.keyGeneration}\0${envelope.messageId}\0${envelope.nonce}\0${envelope.ciphertext}`
}

export function encodeEncryptedFrame(envelope: EncryptedEnvelope): string {
  return JSON.stringify({ type: 'transfer.encrypted', envelope })
}

export function parseEncryptedFrame(value: unknown): EncryptedEnvelope | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const candidate = parsed as Record<string, unknown>
    if (Object.keys(candidate).length !== 2 || candidate.type !== 'transfer.encrypted' || !('envelope' in candidate)) return undefined
    return validateEncryptedEnvelope(candidate.envelope) ? undefined : candidate.envelope as EncryptedEnvelope
  } catch {
    return undefined
  }
}

function parsePlainPayload(bytes: Uint8Array<ArrayBuffer>, envelope: EncryptedEnvelope): PlainPayload {
  const parsed = JSON.parse(decoder.decode(unpadBytes(bytes))) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid encrypted transfer payload')
  const candidate = parsed as Record<string, unknown>
  if (candidate.type === 'text') {
    if (
      Object.keys(candidate).length !== 3
      || candidate.messageId !== envelope.messageId
      || typeof candidate.text !== 'string'
      || validateText(candidate.text)
    ) throw new Error('Invalid encrypted text payload')
    return { type: 'text', messageId: candidate.messageId as string, text: candidate.text }
  }
  if (
    candidate.type === 'ack'
    && Object.keys(candidate).length === 3
    && candidate.messageId === envelope.messageId
    && typeof candidate.acknowledgedMessageId === 'string'
    && candidate.acknowledgedMessageId.length > 0
  ) return {
    type: 'ack',
    messageId: candidate.messageId as string,
    acknowledgedMessageId: candidate.acknowledgedMessageId,
  }
  if (
    candidate.type === 'image.start'
    && Object.keys(candidate).length === 8
    && candidate.messageId === envelope.messageId
    && typeof candidate.transferId === 'string'
    && UUID_PATTERN.test(candidate.transferId)
    && typeof candidate.fileName === 'string'
    && candidate.fileName.length > 0
    && candidate.fileName.length <= MAX_FILE_NAME_LENGTH
    && typeof candidate.mimeType === 'string'
    && isSupportedImageType(candidate.mimeType)
    && Number.isSafeInteger(candidate.size)
    && (candidate.size as number) > 0
    && (candidate.size as number) <= MAX_IMAGE_BYTES
    && Number.isSafeInteger(candidate.chunkCount)
    && candidate.chunkCount === Math.ceil((candidate.size as number) / IMAGE_CHUNK_BYTES)
    && typeof candidate.sha256 === 'string'
    && /^[A-Za-z0-9_-]{43}$/u.test(candidate.sha256)
  ) return candidate as unknown as ImageStartPayload
  if (
    candidate.type === 'image.complete'
    && Object.keys(candidate).length === 3
    && candidate.messageId === envelope.messageId
    && typeof candidate.transferId === 'string'
    && UUID_PATTERN.test(candidate.transferId)
    && candidate.messageId === `${candidate.transferId}:complete`
  ) return candidate as unknown as ImageCompletePayload
  if (
    candidate.type === 'resume'
    && Object.keys(candidate).length === 4
    && candidate.messageId === envelope.messageId
    && Array.isArray(candidate.confirmedMessageIds)
    && candidate.confirmedMessageIds.length <= 512
    && candidate.confirmedMessageIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)
    && Array.isArray(candidate.partialImages)
    && candidate.partialImages.length <= 32
    && candidate.partialImages.every((image) => {
      if (typeof image !== 'object' || image === null) return false
      const item = image as Record<string, unknown>
      return typeof item.transferId === 'string'
        && UUID_PATTERN.test(item.transferId)
        && Array.isArray(item.receivedChunks)
        && item.receivedChunks.length <= 4096
        && item.receivedChunks.every(chunk => Number.isSafeInteger(chunk) && (chunk as number) >= 0)
    })
  ) return candidate as unknown as ResumePayload
  throw new Error('Invalid encrypted transfer payload')
}

export class TransferProtocol {
  private readonly pending = new Map<string, PendingText>()
  private readonly pendingImages = new Map<string, PendingImage>()
  private readonly received = new Map<string, ReceivedFrame>()
  private readonly incomingImages = new Map<string, IncomingImage>()
  private readonly completedImages = new Set<string>()
  private directQueue: Promise<void> = Promise.resolve()
  private eventClock = 0
  private sendingImage = false
  private closed = false
  private resumeSent = false

  constructor(private readonly options: TransferProtocolOptions) {}

  private nextEventTime(candidate = Date.now()): number {
    this.eventClock = Math.max(this.eventClock + 1, candidate)
    return this.eventClock
  }

  async sendText(text: string): Promise<string> {
    const validationError = validateText(text)
    if (validationError) throw new Error(validationError.message)
    const messageId = this.options.createMessageId?.() ?? crypto.randomUUID()
    const payload: TextPayload = { type: 'text', messageId, text }
    const envelope = await this.encryptPayload(payload)
    const frame = encodeEncryptedFrame(envelope)
    const pending: PendingText = { envelope, frame, attempts: 1 }
    this.pending.set(messageId, pending)
    this.options.onText({
      id: `${this.options.cryptoSession.role}:${messageId}`,
      senderRole: this.options.cryptoSession.role,
      messageId,
      text,
      createdAt: this.nextEventTime(),
    })
    if (this.options.sendDirect(frame)) this.scheduleAcknowledgement(messageId)
    else this.sendFallback(pending)
    return messageId
  }

  async sendImage(file: File): Promise<string> {
    if (!isSupportedImageType(file.type)) throw new Error('仅支持 JPEG、PNG、WebP 和 GIF 图片')
    if (file.size < 1 || file.size > MAX_IMAGE_BYTES) throw new Error('图片大小不能超过 10 MB')
    if (file.name.length < 1 || file.name.length > MAX_FILE_NAME_LENGTH) throw new Error('图片文件名无效')
    if (!this.options.sendDirectBinary && !this.options.sendImageFallback) throw new Error('图片传输通道不可用')
    if (this.sendingImage) throw new Error('已有图片正在传输')
    this.sendingImage = true
    try {
      const transferId = this.options.createMessageId?.() ?? crypto.randomUUID()
      uuidToBytes(transferId)
      const bytes = new Uint8Array(await file.arrayBuffer())
      const metadata: ImageStartPayload = {
        type: 'image.start',
        messageId: transferId,
        transferId,
        fileName: file.name,
        mimeType: file.type,
        size: bytes.length,
        chunkCount: Math.ceil(bytes.length / IMAGE_CHUNK_BYTES),
        sha256: await sha256(bytes),
      }
      const metadataEnvelope = await this.encryptPayload(metadata)
      const chunks: ArrayBuffer[] = []
      for (let chunkIndex = 0; chunkIndex < metadata.chunkCount; chunkIndex += 1) {
        const offset = chunkIndex * IMAGE_CHUNK_BYTES
        const chunk = bytes.slice(offset, Math.min(offset + IMAGE_CHUNK_BYTES, bytes.length))
        const envelope = await this.options.cryptoSession.encrypt(
          `${transferId}:${chunkIndex}`,
          padBytes(chunk, IMAGE_PADDED_CHUNK_BYTES),
        )
        await this.options.persistCryptoSession?.()
        chunks.push(encodeImageChunkFrame(transferId, chunkIndex, envelope))
      }
      const completeEnvelope = await this.encryptPayload({
        type: 'image.complete',
        messageId: `${transferId}:complete`,
        transferId,
      })
      const pending: PendingImage = {
        transferId,
        bytes: encodeImageFallbackPackage(metadataEnvelope, chunks, completeEnvelope),
        fallbackStarted: false,
      }
      this.pendingImages.set(transferId, pending)
      const directStarted = this.options.sendDirect(encodeEncryptedFrame(metadataEnvelope))
      if (directStarted && this.options.sendDirectBinary) {
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          if (!await this.options.sendDirectBinary(chunks[chunkIndex]!)) {
            await this.sendImageFallback(pending)
            break
          }
          this.options.onImageProgress?.({
            messageId: transferId,
            transferredBytes: Math.min((chunkIndex + 1) * IMAGE_CHUNK_BYTES, bytes.length),
            totalBytes: bytes.length,
            direction: 'sending',
          })
        }
        if (!pending.fallbackStarted && !this.options.sendDirect(encodeEncryptedFrame(completeEnvelope))) {
          await this.sendImageFallback(pending)
        }
      } else {
        await this.sendImageFallback(pending)
      }
      if (!pending.fallbackStarted) this.scheduleImageAcknowledgement(pending)
      this.options.onImage?.({
        id: `${this.options.cryptoSession.role}:${transferId}`,
        senderRole: this.options.cryptoSession.role,
        messageId: transferId,
        fileName: file.name,
        mimeType: file.type,
        bytes,
        createdAt: this.nextEventTime(),
      })
      return transferId
    } finally {
      this.sendingImage = false
    }
  }

  async handleDirect(data: unknown): Promise<void> {
    const task = this.directQueue.then(() => this.processDirect(data))
    this.directQueue = task.catch(() => undefined)
    return task
  }

  private async processDirect(data: unknown): Promise<void> {
    const envelope = parseEncryptedFrame(data)
    if (envelope) {
      await this.receiveEnvelope(peerRole(this.options.cryptoSession.role), envelope, this.nextEventTime(), 'direct', false)
      return
    }
    await this.receiveImageChunk(data)
  }

  async handleFallback(record: EncryptedTransferRecord, historical = false): Promise<void> {
    await this.receiveEnvelope(record.senderRole, record.envelope, record.createdAt, 'fallback', historical)
  }

  async handleImageFallback(
    bytes: ArrayBuffer,
    senderRole: DeviceRole,
    createdAt: number,
    transferId: string,
  ): Promise<void> {
    if (this.completedImages.has(`${senderRole}:${transferId}`)) return
    const image = parseImageFallbackPackage(bytes)
    if (image.metadata.messageId !== transferId || image.complete.messageId !== `${transferId}:complete`) {
      throw new Error('Image fallback identifier mismatch')
    }
    await this.receiveEnvelope(senderRole, image.metadata, createdAt, 'fallback', false)
    for (const chunk of image.chunks) await this.receiveImageChunk(chunk)
    await this.receiveEnvelope(senderRole, image.complete, createdAt, 'fallback', false)
  }

  async handleTransportState(state: 'connecting' | 'direct' | 'fallback' | 'closed'): Promise<void> {
    if (state === 'direct' && !this.resumeSent) {
      this.resumeSent = true
      await this.sendResume()
      return
    }
    if (state !== 'fallback' && state !== 'closed') return
    this.resumeSent = false
    for (const pending of this.pending.values()) this.sendFallback(pending)
    for (const pending of this.pendingImages.values()) void this.sendImageFallback(pending)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) window.clearTimeout(pending.timer)
    for (const pending of this.pendingImages.values()) window.clearTimeout(pending.timer)
    this.pending.clear()
    this.pendingImages.clear()
    this.received.clear()
    this.incomingImages.clear()
    this.completedImages.clear()
  }

  private async receiveEnvelope(
    senderRole: DeviceRole,
    envelope: EncryptedEnvelope,
    createdAt: number,
    channel: 'direct' | 'fallback',
    historical: boolean,
  ): Promise<void> {
    if (this.closed) return
    const deduplicationKey = `${senderRole}:${envelope.messageId}`
    const fingerprint = envelopeFingerprint(envelope)
    const existing = this.received.get(deduplicationKey)
    if (existing) {
      if (existing.envelopeFingerprint !== fingerprint) return this.fail(new Error('Encrypted message conflict'))
      if (existing.payload.type === 'text' && !historical) await this.sendAck(existing.payload.messageId, channel)
      if (existing.payload.type === 'image.complete') {
        await this.completeImage(existing.payload.transferId, senderRole, channel)
      }
      return
    }
    try {
      const plaintext = await this.options.cryptoSession.decrypt(envelope, senderRole, historical)
      const payload = parsePlainPayload(plaintext, envelope)
      this.received.set(deduplicationKey, { envelopeFingerprint: fingerprint, payload })
      await this.options.persistCryptoSession?.()
      if (payload.type === 'ack') {
        this.completePending(payload.acknowledgedMessageId)
        return
      }
      if (payload.type === 'resume') {
        await this.handleResume(payload, senderRole)
        if (!historical && !this.resumeSent) {
          this.resumeSent = true
          await this.sendResume()
        }
        return
      }
      if (payload.type === 'image.start') {
        if (this.incomingImages.size > 0 && !this.incomingImages.has(payload.transferId)) {
          throw new Error('Another encrypted image is already being received')
        }
        this.incomingImages.set(payload.transferId, {
          senderRole,
          metadata: payload,
          keyGeneration: envelope.keyGeneration,
          chunks: new Map(),
          receivedBytes: 0,
          createdAt,
        })
        return
      }
      if (payload.type === 'image.complete') {
        await this.completeImage(payload.transferId, senderRole, channel)
        return
      }
      this.options.onText({
        id: deduplicationKey,
        senderRole,
        messageId: payload.messageId,
        text: payload.text,
        createdAt,
      })
      if (!historical && senderRole !== this.options.cryptoSession.role) await this.sendAck(payload.messageId, channel)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Encrypted transfer failed'))
    }
  }

  private async receiveImageChunk(data: unknown): Promise<void> {
    if (this.closed) return
    const rawBytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined
    if (!rawBytes || rawBytes.length < 20) return
    const transferId = bytesToUuid(rawBytes.subarray(0, 16))
    const incoming = this.incomingImages.get(transferId)
    if (!incoming) return this.fail(new Error('Image chunk arrived before metadata'))
    const parsed = parseImageChunkFrame(data, incoming.keyGeneration)
    if (!parsed || parsed.chunkIndex >= incoming.metadata.chunkCount) return this.fail(new Error('Invalid encrypted image chunk'))
    if (incoming.chunks.has(parsed.chunkIndex)) return
    try {
      const padded = await this.options.cryptoSession.decrypt(parsed.envelope, incoming.senderRole)
      const chunk = unpadBytes(padded)
      const expectedLength = parsed.chunkIndex === incoming.metadata.chunkCount - 1
        ? incoming.metadata.size - parsed.chunkIndex * IMAGE_CHUNK_BYTES
        : IMAGE_CHUNK_BYTES
      if (chunk.length !== expectedLength) throw new Error('Invalid encrypted image chunk length')
      incoming.chunks.set(parsed.chunkIndex, chunk)
      incoming.receivedBytes += chunk.length
      await this.options.persistCryptoSession?.()
      this.options.onImageProgress?.({
        messageId: transferId,
        transferredBytes: incoming.receivedBytes,
        totalBytes: incoming.metadata.size,
        direction: 'receiving',
      })
    } catch (error) {
      this.incomingImages.delete(transferId)
      this.fail(error instanceof Error ? error : new Error('Encrypted image chunk failed'))
    }
  }

  private async completeImage(transferId: string, senderRole: DeviceRole, channel: 'direct' | 'fallback'): Promise<void> {
    const incoming = this.incomingImages.get(transferId)
    if (!incoming || incoming.senderRole !== senderRole) throw new Error('Image completion does not match metadata')
    if (incoming.chunks.size !== incoming.metadata.chunkCount || incoming.receivedBytes !== incoming.metadata.size) {
      return
    }
    const bytes = new Uint8Array(incoming.metadata.size)
    for (let chunkIndex = 0; chunkIndex < incoming.metadata.chunkCount; chunkIndex += 1) {
      const chunk = incoming.chunks.get(chunkIndex)
      if (!chunk) return
      bytes.set(chunk, chunkIndex * IMAGE_CHUNK_BYTES)
    }
    if (await sha256(bytes) !== incoming.metadata.sha256) {
      this.incomingImages.delete(transferId)
      throw new Error('Image digest verification failed')
    }
    this.completedImages.add(`${senderRole}:${transferId}`)
    this.options.onImage?.({
      id: `${senderRole}:${transferId}`,
      senderRole,
      messageId: transferId,
      fileName: incoming.metadata.fileName,
      mimeType: incoming.metadata.mimeType,
      bytes,
      createdAt: this.nextEventTime(incoming.createdAt),
    })
    await this.sendAck(transferId, channel)
    this.incomingImages.delete(transferId)
  }

  private async sendAck(messageId: string, channel: 'direct' | 'fallback'): Promise<void> {
    const acknowledgementId = this.options.createMessageId?.() ?? crypto.randomUUID()
    const envelope = await this.encryptPayload({
      type: 'ack',
      messageId: acknowledgementId,
      acknowledgedMessageId: messageId,
    })
    const frame = encodeEncryptedFrame(envelope)
    if (channel === 'direct' && this.options.sendDirect(frame)) return
    this.options.sendFallback(envelope)
  }

  private async encryptPayload(payload: PlainPayload): Promise<EncryptedEnvelope> {
    const envelope = await this.options.cryptoSession.encrypt(
      payload.messageId,
      padTextBytes(encoder.encode(JSON.stringify(payload))),
    )
    await this.options.persistCryptoSession?.()
    return envelope
  }

  private scheduleAcknowledgement(messageId: string): void {
    const pending = this.pending.get(messageId)
    if (!pending || this.closed) return
    window.clearTimeout(pending.timer)
    pending.timer = window.setTimeout(() => {
      if (pending.attempts === 1) {
        pending.attempts += 1
        if (this.options.sendDirect(pending.frame)) this.scheduleAcknowledgement(messageId)
        else this.sendFallback(pending)
      } else this.sendFallback(pending)
    }, this.options.acknowledgementTimeoutMs ?? 5_000)
  }

  private sendFallback(pending: PendingText): void {
    window.clearTimeout(pending.timer)
    this.options.sendFallback(pending.envelope)
  }

  private completePending(messageId: string): void {
    const image = this.pendingImages.get(messageId)
    if (image) {
      window.clearTimeout(image.timer)
      this.pendingImages.delete(messageId)
      return
    }
    const pending = this.pending.get(messageId)
    if (!pending) return
    window.clearTimeout(pending.timer)
    this.pending.delete(messageId)
  }

  private scheduleImageAcknowledgement(pending: PendingImage): void {
    window.clearTimeout(pending.timer)
    pending.timer = window.setTimeout(
      () => void this.sendImageFallback(pending),
      this.options.acknowledgementTimeoutMs ?? 5_000,
    )
  }

private getConfirmedMessageIds(): string[] {
    const ids: string[] = []
    for (const { payload } of this.received.values()) {
      if (payload.type === 'text') ids.push(payload.messageId)
      if (payload.type === 'image.complete') ids.push(payload.transferId)
    }
    return ids
  }

  private async sendResume(): Promise<void> {
    const partialImages: PartialImageState[] = []
    for (const [transferId, incoming] of this.incomingImages) {
      partialImages.push({
        transferId,
        receivedChunks: [...incoming.chunks.keys()].sort((a, b) => a - b),
      })
    }
    const messageId = `resume:${this.options.createMessageId?.() ?? crypto.randomUUID()}`
    const payload: ResumePayload = {
      type: 'resume',
      messageId,
      confirmedMessageIds: this.getConfirmedMessageIds(),
      partialImages,
    }
    const envelope = await this.encryptPayload(payload)
    const frame = encodeEncryptedFrame(envelope)
    this.options.sendDirect(frame)
  }

  private async handleResume(payload: ResumePayload, senderRole: DeviceRole): Promise<void> {
    for (const partial of payload.partialImages) {
      const pending = this.pendingImages.get(partial.transferId)
      if (!pending || pending.fallbackStarted) continue
      const peerChunks = new Set(partial.receivedChunks)
      const fallback = parseImageFallbackPackage(pending.bytes.buffer)
      let retransmitted = false
      for (let chunkIndex = 0; chunkIndex < fallback.chunks.length; chunkIndex += 1) {
        if (peerChunks.has(chunkIndex)) continue
        if (!this.options.sendDirectBinary) break
        await this.options.sendDirectBinary(fallback.chunks[chunkIndex]!)
        retransmitted = true
      }
      if (retransmitted && this.options.sendDirect(encodeEncryptedFrame(fallback.complete))) {
        this.pendingImages.delete(partial.transferId)
      }
    }
    for (const peerMessageId of payload.confirmedMessageIds) {
      const pending = this.pending.get(peerMessageId)
      if (pending) {
        window.clearTimeout(pending.timer)
        this.pending.delete(peerMessageId)
      }
      const image = this.pendingImages.get(peerMessageId)
      if (image && !image.fallbackStarted) {
        window.clearTimeout(image.timer)
        this.pendingImages.delete(peerMessageId)
      }
    }
  }

  private async sendImageFallback(pending: PendingImage): Promise<void> {
    if (pending.fallbackStarted || this.closed || !this.options.sendImageFallback) return
    pending.fallbackStarted = true
    window.clearTimeout(pending.timer)
    try {
      await this.options.sendImageFallback(pending.transferId, pending.bytes)
    } catch (error) {
      pending.fallbackStarted = false
      this.fail(error instanceof Error ? error : new Error('Encrypted image fallback failed'))
    }
  }

  private fail(error: Error): void {
    this.options.onError?.(error)
  }
}
