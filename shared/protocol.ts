export const ROOM_PAIRING_TTL_MS = 5 * 60 * 1000
export const RECONNECT_GRACE_MS = 60 * 1000
export const MAX_TEXT_LENGTH = 10_000
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IDENTIFIER_LENGTH = 128
export const MAX_FILE_NAME_LENGTH = 255

export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number]
export type RoomStatus = 'waiting' | 'paired' | 'closing'
export type MessageKind = 'text' | 'image'

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

export interface ImageMetadata {
  imageId: string
  fileName: string
  mimeType: SupportedImageType
  size: number
}

export type ImageUploadResponse = ImageMetadata

export interface TextSendMessage {
  type: 'text.send'
  clientMessageId: string
  text: string
}

export interface ImageSendMessage {
  type: 'image.send'
  clientMessageId: string
  image: ImageMetadata
}

export interface RetryMessage {
  type: 'message.retry'
  clientMessageId: string
}

export interface SessionCloseMessage {
  type: 'session.close'
}

export interface PingMessage {
  type: 'ping'
}

export type ClientMessage =
  | TextSendMessage
  | ImageSendMessage
  | RetryMessage
  | SessionCloseMessage
  | PingMessage

export interface RoomPairedEvent {
  type: 'room.paired'
}

export interface PeerStatusEvent {
  type: 'peer.online' | 'peer.offline'
}

export interface MessageDeliverEvent {
  type: 'message.deliver'
  message: {
    id: string
    clientMessageId: string
    senderDeviceId: string
    kind: MessageKind
    text?: string
    image?: ImageMetadata
    createdAt: number
  }
}

export interface MessageAckEvent {
  type: 'message.ack'
  clientMessageId: string
}

export interface SessionClosedEvent {
  type: 'session.closed'
}

export interface SessionReadyEvent {
  type: 'session.ready'
  deviceId: string
  roomStatus: RoomStatus
  peerOnline: boolean
  messages: MessageDeliverEvent['message'][]
}

export interface PongEvent {
  type: 'pong'
}

export interface ErrorEvent {
  type: 'error'
  error: ApiError
}

export type ServerMessage =
  | RoomPairedEvent
  | PeerStatusEvent
  | MessageDeliverEvent
  | MessageAckEvent
  | SessionClosedEvent
  | SessionReadyEvent
  | PongEvent
  | ErrorEvent

export function parseClientMessage(value: unknown): ClientMessage | ApiError {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return { code: 'MESSAGE_INVALID', message: '消息格式无效' }
  }
  const candidate = value as Record<string, unknown>
  if (candidate.type === 'ping' || candidate.type === 'session.close') {
    return { type: candidate.type }
  }
  if (candidate.type === 'text.send') {
    if (!isValidIdentifier(candidate.clientMessageId)) {
      return { code: 'MESSAGE_INVALID', message: '消息标识无效' }
    }
    const textError = validateText(candidate.text)
    if (textError) return textError
    return {
      type: 'text.send',
      clientMessageId: candidate.clientMessageId,
      text: candidate.text as string,
    }
  }
  if (candidate.type === 'image.send') {
    if (!isValidIdentifier(candidate.clientMessageId)) {
      return { code: 'MESSAGE_INVALID', message: '消息标识无效' }
    }
    const image = candidate.image as Record<string, unknown> | undefined
    const imageError = validateImageUpload(image?.mimeType, image?.size)
    if (
      imageError
      || !isValidIdentifier(image?.imageId)
      || typeof image.fileName !== 'string'
      || image.fileName.trim().length === 0
      || image.fileName.length > MAX_FILE_NAME_LENGTH
    ) {
      return imageError ?? { code: 'MESSAGE_INVALID', message: '图片元数据无效' }
    }
    return {
      type: 'image.send',
      clientMessageId: candidate.clientMessageId,
      image: image as unknown as ImageMetadata,
    }
  }
  if (candidate.type === 'message.retry' && isValidIdentifier(candidate.clientMessageId)) {
    return { type: 'message.retry', clientMessageId: candidate.clientMessageId }
  }
  return { code: 'MESSAGE_INVALID', message: '消息格式无效' }
}

function isValidIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH
}

export function isSupportedImageType(value: string): value is SupportedImageType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(value)
}

export function validateText(text: unknown): ApiError | null {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { code: 'TEXT_EMPTY', message: '请输入有效文字' }
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return { code: 'TEXT_TOO_LONG', message: `文字长度不能超过 ${MAX_TEXT_LENGTH} 个字符` }
  }
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
