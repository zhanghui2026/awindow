import type {
  DeviceRole,
  EncryptedEnvelope,
  KeyExchangeEvent,
  RoomStatus,
  VerificationStatus,
} from '../../shared/protocol.js'

export interface DeviceSession {
  id: string
  role: DeviceRole
  tokenHash: string
  connected: boolean
  lastSeenAt: number
}

export interface TransferMessage {
  id: string
  senderDeviceId: string
  senderRole: DeviceRole
  envelope: EncryptedEnvelope
  createdAt: number
}

export interface EncryptedImageAsset {
  imageId: string
  transferId: string
  senderDeviceId: string
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
  images: Map<string, EncryptedImageAsset>
  keyExchanges: Map<DeviceRole, KeyExchangeEvent>
  verificationStatus: VerificationStatus
  verificationConfirmations: Set<DeviceRole>
  verificationExpiresAt?: number
  negotiationId?: string
  iceCandidateCount: number
}
