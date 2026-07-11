import type { ImageMetadata, RoomStatus } from '../../shared/protocol.js'

export interface DeviceSession {
  id: string
  tokenHash: string
  connected: boolean
  lastSeenAt: number
}

export interface TransferMessage {
  id: string
  clientMessageId: string
  senderDeviceId: string
  kind: 'text' | 'image'
  text?: string
  image?: ImageMetadata
  createdAt: number
}

export interface ImageAsset extends ImageMetadata {
  bytes: Buffer
  createdAt: number
}

export interface Room {
  id: string
  pairingCodeHash: string
  status: RoomStatus
  createdAt: number
  pairingExpiresAt: number
  disconnectExpiresAt?: number
  devices: Map<string, DeviceSession>
  messages: TransferMessage[]
  images: Map<string, ImageAsset>
}
