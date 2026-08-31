import type {
  CreateRoomResponse,
  ClientMessage,
  EncryptedImageUploadResponse,
  JoinRoomResponse,
  ServerMessage,
  SessionAuthMessage,
  WebRtcConfigResponse,
} from '../../shared/protocol.js'
import type { StoredCryptoSession } from './crypto-session.js'

export interface StoredSession {
  roomId: string
  deviceToken: string
  pairingCode?: string
  expiresAt?: number
  joinUrl?: string
  verificationExpiresAt?: number
  crypto?: StoredCryptoSession
}

export class TransferClient extends EventTarget {
  private socket?: WebSocket
  private reconnectTimer?: number
  private reconnectStartedAt?: number
  private heartbeatTimer?: number

  constructor(public readonly session: StoredSession) {
    super()
  }

  static async createRoom(): Promise<CreateRoomResponse> {
    return TransferClient.request<CreateRoomResponse>('/api/rooms', { method: 'POST' })
  }

  static async joinRoom(pairingCode: string): Promise<JoinRoomResponse> {
    return TransferClient.request<JoinRoomResponse>('/api/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    })
  }

  async webRtcConfig(): Promise<WebRtcConfigResponse> {
    return TransferClient.request<WebRtcConfigResponse>(`/api/webrtc/config?roomId=${encodeURIComponent(this.session.roomId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.session.deviceToken}` },
    })
  }

  connect(): void {
    window.clearTimeout(this.reconnectTimer)
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${location.host}/ws`
    this.socket = new WebSocket(url)
    this.socket.addEventListener('open', () => {
      this.reconnectStartedAt = undefined
      this.socket?.send(JSON.stringify({
        type: 'session.auth',
        roomId: this.session.roomId,
        deviceToken: this.session.deviceToken,
      } satisfies SessionAuthMessage))
      this.dispatchEvent(new Event('connected'))
      this.heartbeatTimer = window.setInterval(() => this.send({ type: 'ping' }), 25_000)
    })
    this.socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage
        this.dispatchEvent(new CustomEvent<ServerMessage>('message', { detail: message }))
      } catch {
        this.dispatchEvent(new CustomEvent('protocol-error'))
      }
    })
    this.socket.addEventListener('close', (event) => {
      window.clearInterval(this.heartbeatTimer)
      this.dispatchEvent(new Event('disconnected'))
      if (event.code === 4001 || event.code === 1000 || event.code === 4401) return
      this.scheduleReconnect()
    })
  }

  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  async uploadEncryptedImage(transferId: string, binary: Uint8Array<ArrayBuffer>): Promise<EncryptedImageUploadResponse> {
    let encoded = ''
    for (let offset = 0; offset < binary.length; offset += 32_768) {
      encoded += String.fromCharCode(...binary.subarray(offset, offset + 32_768))
    }
    return TransferClient.request<EncryptedImageUploadResponse>(`/api/rooms/${this.session.roomId}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.session.deviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transferId, bytes: btoa(encoded) }),
    })
  }

  imageUrl(imageId: string): string {
    return `/api/rooms/${this.session.roomId}/images/${imageId}`
  }

  async fetchEncryptedImage(imageId: string): Promise<ArrayBuffer> {
    const response = await fetch(this.imageUrl(imageId), {
      headers: { Authorization: `Bearer ${this.session.deviceToken}` },
    })
    if (!response.ok) throw await response.json()
    return response.arrayBuffer()
  }

  async close(): Promise<void> {
    this.send({ type: 'session.close' })
    this.disconnect()
  }

  disconnect(): void {
    window.clearTimeout(this.reconnectTimer)
    window.clearInterval(this.heartbeatTimer)
    this.socket?.close(1000)
    this.socket = undefined
  }

  private scheduleReconnect(): void {
    this.reconnectStartedAt ??= Date.now()
    if (Date.now() - this.reconnectStartedAt >= 60_000) {
      this.dispatchEvent(new Event('expired'))
      return
    }
    this.reconnectTimer = window.setTimeout(() => this.connect(), 2_000)
  }

  private static async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(path, init)
    const body = await response.text()
    let parsed: unknown
    try {
      parsed = body ? JSON.parse(body) : undefined
    } catch {
      parsed = undefined
    }
    if (!response.ok) throw parsed ?? { message: `请求失败（${response.status}）` }
    return parsed as T
  }
}
