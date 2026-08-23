export const ROOM_PAIRING_TTL_MS = 5 * 60 * 1000
export const RECONNECT_GRACE_MS = 60 * 1000
export const VERIFICATION_TTL_MS = 5 * 60 * 1000
export const MAX_TEXT_LENGTH = 10_000
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_CHUNKS = Math.ceil(MAX_IMAGE_BYTES / (32 * 1024))
export const MAX_ENCRYPTED_IMAGE_BYTES = MAX_IMAGE_CHUNKS * (32 + 64 * 1024 + 16) + 256 * 1024
export const MAX_IDENTIFIER_LENGTH = 128
export const MAX_FILE_NAME_LENGTH = 255
export const MAX_PUBLIC_KEY_LENGTH = 2_048
export const MAX_KEY_PROOF_LENGTH = 128
export const MAX_SDP_LENGTH = 32 * 1024
export const MAX_ICE_CANDIDATE_LENGTH = 2_048
export const MAX_ICE_CANDIDATES_PER_NEGOTIATION = 256
export const MAX_ENVELOPE_CIPHERTEXT_LENGTH = 96 * 1024
export const MAX_WEBSOCKET_PAYLOAD_BYTES = 128 * 1024

export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number]
export type RoomStatus = 'waiting' | 'paired' | 'closing'
export type DeviceRole = 'creator' | 'joiner'
export type VerificationStatus = 'pending' | 'verified' | 'failed'

export interface ApiError {
  code: string
  message: string
  retryAfterSeconds?: number
}

export interface CreateRoomResponse {
  roomId: string
  pairingCode: string
  deviceToken: string
  expiresAt: number
  joinUrl: string
}

export interface JoinRoomRequest {
  pairingCode: string
}

export interface JoinRoomResponse {
  roomId: string
  deviceToken: string
  status: RoomStatus
}

export interface EncryptedEnvelope {
  version: 1
  keyGeneration: number
  messageId: string
  nonce: string
  ciphertext: string
}

export interface EncryptedImageUploadResponse {
  imageId: string
  transferId: string
  size: number
  duplicate: boolean
}

export interface IceServerConfiguration {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface WebRtcConfigResponse {
  iceServers: IceServerConfiguration[]
  negotiationTimeoutMs: number
}

export interface KeyExchangeMessage {
  type: 'key.exchange'
  publicKey: string
  proof?: string
}

export interface VerificationConfirmMessage {
  type: 'verification.confirm'
  matched: boolean
}

export interface WebRtcOfferMessage {
  type: 'webrtc.offer'
  negotiationId: string
  description: { type: 'offer'; sdp: string }
}

export interface WebRtcAnswerMessage {
  type: 'webrtc.answer'
  negotiationId: string
  description: { type: 'answer'; sdp: string }
}

export interface WebRtcIceMessage {
  type: 'webrtc.ice'
  negotiationId: string
  candidate: {
    candidate: string
    sdpMid?: string | null
    sdpMLineIndex?: number | null
    usernameFragment?: string | null
  }
}

export interface WebRtcRestartMessage {
  type: 'webrtc.restart'
  negotiationId: string
}

export interface TransferFallbackMessage {
  type: 'transfer.fallback'
  envelope: EncryptedEnvelope
}

export interface ImageFallbackMessage {
  type: 'image.fallback'
  transferId: string
  imageId: string
}

export interface RetryMessage {
  type: 'message.retry'
  messageId: string
}

export interface SessionCloseMessage {
  type: 'session.close'
}

export interface PingMessage {
  type: 'ping'
}

export type ClientMessage =
  | KeyExchangeMessage
  | VerificationConfirmMessage
  | WebRtcOfferMessage
  | WebRtcAnswerMessage
  | WebRtcIceMessage
  | WebRtcRestartMessage
  | TransferFallbackMessage
  | ImageFallbackMessage
  | RetryMessage
  | SessionCloseMessage
  | PingMessage

export interface KeyExchangeEvent extends KeyExchangeMessage {
  senderRole: DeviceRole
}

export interface VerificationStatusEvent {
  type: 'verification.status'
  status: VerificationStatus
}

export interface WebRtcOfferEvent extends WebRtcOfferMessage {
  senderRole: 'creator'
}

export interface WebRtcAnswerEvent extends WebRtcAnswerMessage {
  senderRole: 'joiner'
}

export interface WebRtcIceEvent extends WebRtcIceMessage {
  senderRole: DeviceRole
}

export interface WebRtcRestartEvent extends WebRtcRestartMessage {
  senderRole: 'creator'
}

export interface RoomPairedEvent {
  type: 'room.paired'
}

export interface PeerStatusEvent {
  type: 'peer.online' | 'peer.offline'
}

export interface EncryptedTransferRecord {
  id: string
  senderRole: DeviceRole
  envelope: EncryptedEnvelope
  createdAt: number
}

export interface MessageDeliverEvent {
  type: 'message.deliver'
  message: EncryptedTransferRecord
}

export interface MessageAckEvent {
  type: 'message.ack'
  messageId: string
}

export interface ImageDeliverEvent {
  type: 'image.deliver'
  transferId: string
  imageId: string
  senderRole: DeviceRole
  createdAt: number
}

export interface SessionClosedEvent {
  type: 'session.closed'
}

export interface SessionReadyEvent {
  type: 'session.ready'
  deviceId: string
  role: DeviceRole
  roomStatus: RoomStatus
  peerOnline: boolean
  verificationStatus: VerificationStatus
  keyExchanges: KeyExchangeEvent[]
  messages: EncryptedTransferRecord[]
}

export interface PongEvent {
  type: 'pong'
}

export interface ErrorEvent {
  type: 'error'
  error: ApiError
}

export type ServerMessage =
  | KeyExchangeEvent
  | VerificationStatusEvent
  | WebRtcOfferEvent
  | WebRtcAnswerEvent
  | WebRtcIceEvent
  | WebRtcRestartEvent
  | RoomPairedEvent
  | PeerStatusEvent
  | MessageDeliverEvent
  | MessageAckEvent
  | ImageDeliverEvent
  | SessionClosedEvent
  | SessionReadyEvent
  | PongEvent
  | ErrorEvent

const invalidMessage: ApiError = { code: 'MESSAGE_INVALID', message: '消息格式无效' }

function hasExactKeys(candidate: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => key in candidate)
    && Object.keys(candidate).every((key) => allowed.has(key))
}

export function isValidIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH
}

function isBase64Url(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) return false
  const remainder = value.length % 4
  if (remainder === 1) return false
  if (remainder === 0) return true
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const finalValue = alphabet.indexOf(value.at(-1) ?? '')
  return remainder === 2 ? (finalValue & 0b1111) === 0 : (finalValue & 0b11) === 0
}

function decodedBase64UrlLength(value: string): number {
  return Math.floor(value.length * 3 / 4)
}

export function validateEncryptedEnvelope(value: unknown): ApiError | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidMessage
  const candidate = value as Record<string, unknown>
  if (!hasExactKeys(candidate, ['version', 'keyGeneration', 'messageId', 'nonce', 'ciphertext'])) return invalidMessage
  if (
    candidate.version !== 1
    || !Number.isSafeInteger(candidate.keyGeneration)
    || (candidate.keyGeneration as number) < 1
    || !isValidIdentifier(candidate.messageId)
    || !isBase64Url(candidate.nonce)
    || decodedBase64UrlLength(candidate.nonce) !== 12
    || !isBase64Url(candidate.ciphertext)
    || (candidate.ciphertext as string).length > MAX_ENVELOPE_CIPHERTEXT_LENGTH
    || decodedBase64UrlLength(candidate.ciphertext as string) < 16
  ) return invalidMessage
  return null
}

function parseDescription(candidate: Record<string, unknown>, type: 'offer' | 'answer'): ClientMessage | ApiError {
  if (!hasExactKeys(candidate, ['type', 'negotiationId', 'description']) || !isValidIdentifier(candidate.negotiationId)) {
    return invalidMessage
  }
  const description = candidate.description
  if (typeof description !== 'object' || description === null || Array.isArray(description)) return invalidMessage
  const value = description as Record<string, unknown>
  if (!hasExactKeys(value, ['type', 'sdp']) || value.type !== type || typeof value.sdp !== 'string' || value.sdp.length < 1 || value.sdp.length > MAX_SDP_LENGTH) {
    return { code: 'WEBRTC_SIGNAL_INVALID', message: 'WebRTC 信令无效' }
  }
  return {
    type: type === 'offer' ? 'webrtc.offer' : 'webrtc.answer',
    negotiationId: candidate.negotiationId,
    description: { type, sdp: value.sdp },
  } as WebRtcOfferMessage | WebRtcAnswerMessage
}

export function parseClientMessage(value: unknown): ClientMessage | ApiError {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('type' in value)) return invalidMessage
  const candidate = value as Record<string, unknown>
  if ((candidate.type === 'ping' || candidate.type === 'session.close') && hasExactKeys(candidate, ['type'])) {
    return { type: candidate.type }
  }
  if (candidate.type === 'key.exchange') {
    if (
      !hasExactKeys(candidate, ['type', 'publicKey'], ['proof'])
      || typeof candidate.publicKey !== 'string'
      || candidate.publicKey.length < 1
      || candidate.publicKey.length > MAX_PUBLIC_KEY_LENGTH
      || (candidate.proof !== undefined && (typeof candidate.proof !== 'string' || candidate.proof.length < 1 || candidate.proof.length > MAX_KEY_PROOF_LENGTH))
    ) return invalidMessage
    return { type: 'key.exchange', publicKey: candidate.publicKey, ...(candidate.proof ? { proof: candidate.proof as string } : {}) }
  }
  if (candidate.type === 'verification.confirm') {
    return hasExactKeys(candidate, ['type', 'matched']) && typeof candidate.matched === 'boolean'
      ? { type: 'verification.confirm', matched: candidate.matched }
      : invalidMessage
  }
  if (candidate.type === 'webrtc.offer') return parseDescription(candidate, 'offer')
  if (candidate.type === 'webrtc.answer') return parseDescription(candidate, 'answer')
  if (candidate.type === 'webrtc.restart') {
    return hasExactKeys(candidate, ['type', 'negotiationId']) && isValidIdentifier(candidate.negotiationId)
      ? { type: 'webrtc.restart', negotiationId: candidate.negotiationId }
      : invalidMessage
  }
  if (candidate.type === 'webrtc.ice') {
    if (!hasExactKeys(candidate, ['type', 'negotiationId', 'candidate']) || !isValidIdentifier(candidate.negotiationId)) return invalidMessage
    const ice = candidate.candidate
    if (typeof ice !== 'object' || ice === null || Array.isArray(ice)) return invalidMessage
    const item = ice as Record<string, unknown>
    if (!hasExactKeys(item, ['candidate'], ['sdpMid', 'sdpMLineIndex', 'usernameFragment'])) return invalidMessage
    if (typeof item.candidate !== 'string' || item.candidate.length < 1 || item.candidate.length > MAX_ICE_CANDIDATE_LENGTH) {
      return { code: 'WEBRTC_SIGNAL_INVALID', message: 'WebRTC 信令无效' }
    }
    if (item.sdpMid !== undefined && item.sdpMid !== null && (typeof item.sdpMid !== 'string' || item.sdpMid.length > MAX_IDENTIFIER_LENGTH)) return invalidMessage
    if (item.usernameFragment !== undefined && item.usernameFragment !== null && (typeof item.usernameFragment !== 'string' || item.usernameFragment.length > MAX_IDENTIFIER_LENGTH)) return invalidMessage
    if (item.sdpMLineIndex !== undefined && item.sdpMLineIndex !== null && (!Number.isSafeInteger(item.sdpMLineIndex) || (item.sdpMLineIndex as number) < 0)) return invalidMessage
    return {
      type: 'webrtc.ice',
      negotiationId: candidate.negotiationId,
      candidate: {
        candidate: item.candidate,
        ...(item.sdpMid !== undefined ? { sdpMid: item.sdpMid as string | null } : {}),
        ...(item.sdpMLineIndex !== undefined ? { sdpMLineIndex: item.sdpMLineIndex as number | null } : {}),
        ...(item.usernameFragment !== undefined ? { usernameFragment: item.usernameFragment as string | null } : {}),
      },
    }
  }
  if (candidate.type === 'transfer.fallback') {
    const error = validateEncryptedEnvelope(candidate.envelope)
    return hasExactKeys(candidate, ['type', 'envelope']) && !error
      ? { type: 'transfer.fallback', envelope: candidate.envelope as EncryptedEnvelope }
      : error ?? invalidMessage
  }
  if (candidate.type === 'image.fallback') {
    return hasExactKeys(candidate, ['type', 'transferId', 'imageId'])
      && isValidIdentifier(candidate.transferId)
      && isValidIdentifier(candidate.imageId)
      ? { type: 'image.fallback', transferId: candidate.transferId, imageId: candidate.imageId }
      : invalidMessage
  }
  if (candidate.type === 'message.retry' && hasExactKeys(candidate, ['type', 'messageId']) && isValidIdentifier(candidate.messageId)) {
    return { type: 'message.retry', messageId: candidate.messageId }
  }
  return invalidMessage
}

export function isSupportedImageType(value: string): value is SupportedImageType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(value)
}

export function validateText(text: unknown): ApiError | null {
  if (typeof text !== 'string' || text.trim().length === 0) return { code: 'TEXT_EMPTY', message: '请输入有效文字' }
  if (text.length > MAX_TEXT_LENGTH) return { code: 'TEXT_TOO_LONG', message: `文字长度不能超过 ${MAX_TEXT_LENGTH} 个字符` }
  return null
}

export function validateImageUpload(mimeType: unknown, size: unknown): ApiError | null {
  if (typeof mimeType !== 'string' || !isSupportedImageType(mimeType)) {
    return { code: 'IMAGE_TYPE_UNSUPPORTED', message: '仅支持 JPEG、PNG、WebP 和 GIF 图片' }
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_BYTES) {
    return { code: 'IMAGE_TOO_LARGE', message: '图片大小不能超过 10 MB' }
  }
  return null
}
