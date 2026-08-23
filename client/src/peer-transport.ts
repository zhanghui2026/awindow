import type {
  DeviceRole,
  IceServerConfiguration,
  WebRtcAnswerEvent,
  WebRtcIceEvent,
  WebRtcOfferEvent,
  WebRtcRestartEvent,
} from '../../shared/protocol.js'

export type PeerTransportState = 'connecting' | 'direct' | 'fallback' | 'closed'
export type PeerSignal = WebRtcOfferEvent | WebRtcAnswerEvent | WebRtcIceEvent | WebRtcRestartEvent

interface DataChannelLike {
  readonly label: string
  readonly ordered: boolean
  readonly readyState: RTCDataChannelState
  readonly bufferedAmount: number
  bufferedAmountLowThreshold: number
  binaryType: BinaryType
  onopen: ((event: Event) => void) | null
  onclose: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onbufferedamountlow: ((event: Event) => void) | null
  addEventListener?(type: string, listener: () => void, options?: AddEventListenerOptions): void
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(): void
}

interface PeerConnectionLike {
  readonly connectionState: RTCPeerConnectionState
  readonly localDescription: RTCSessionDescription | null
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null
  onconnectionstatechange: ((event: Event) => void) | null
  createDataChannel(label: string, options?: RTCDataChannelInit): DataChannelLike
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>
  createAnswer(): Promise<RTCSessionDescriptionInit>
  setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void>
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>
  addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void>
  close(): void
}

type OutgoingSignal =
  | { type: 'webrtc.offer'; negotiationId: string; description: { type: 'offer'; sdp: string } }
  | { type: 'webrtc.answer'; negotiationId: string; description: { type: 'answer'; sdp: string } }
  | {
      type: 'webrtc.ice'
      negotiationId: string
      candidate: {
        candidate: string
        sdpMid?: string | null
        sdpMLineIndex?: number | null
        usernameFragment?: string | null
      }
    }
  | { type: 'webrtc.restart'; negotiationId: string }

export interface PeerTransportOptions {
  role: DeviceRole
  iceServers: IceServerConfiguration[]
  negotiationTimeoutMs?: number
  restartDelayMs?: number
  sendSignal: (message: OutgoingSignal) => boolean
  createPeerConnection?: (configuration: RTCConfiguration) => PeerConnectionLike
  createNegotiationId?: () => string
}

const DATA_CHANNEL_LABEL = 'awindow-transfer'
const BUFFER_HIGH_WATER_BYTES = 512 * 1024
const BUFFER_LOW_WATER_BYTES = 128 * 1024

export class PeerTransport extends EventTarget {
  private peer?: PeerConnectionLike
  private channel?: DataChannelLike
  private negotiationId?: string
  private negotiationTimer?: number
  private restartTimer?: number
  private remoteCandidates: RTCIceCandidateInit[] = []
  private localCandidates: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false
  private signalReady = false
  private terminal = false
  private bufferWaiter?: (available: boolean) => void
  private currentState: PeerTransportState = 'connecting'

  constructor(private readonly options: PeerTransportOptions) {
    super()
  }

  get state(): PeerTransportState {
    return this.currentState
  }

  async start(): Promise<void> {
    if (this.terminal) return
    if (this.options.role === 'creator') await this.negotiate(false)
    else this.ensurePeer()
  }

  async restart(): Promise<void> {
    if (this.terminal || this.options.role !== 'creator') return
    await this.negotiate(true)
  }

  async handleSignal(message: PeerSignal): Promise<void> {
    if (this.terminal || message.senderRole === this.options.role) return
    if (message.type === 'webrtc.restart') {
      if (this.options.role === 'joiner') this.resetPeer(message.negotiationId)
      return
    }
    if (message.type === 'webrtc.offer') {
      if (this.options.role !== 'joiner') return
      await this.acceptOffer(message)
      return
    }
    if (message.type === 'webrtc.answer') {
      if (this.options.role !== 'creator' || message.negotiationId !== this.negotiationId) return
      const peer = this.ensurePeer()
      await peer.setRemoteDescription(message.description)
      this.remoteDescriptionSet = true
      await this.flushRemoteCandidates()
      return
    }
    if (message.negotiationId !== this.negotiationId) return
    if (!this.remoteDescriptionSet) this.remoteCandidates.push(message.candidate)
    else await this.ensurePeer().addIceCandidate(message.candidate)
  }

  send(data: string | ArrayBuffer | ArrayBufferView): boolean {
    if (this.channel?.readyState !== 'open') return false
    this.channel.send(data)
    return true
  }

  async sendWithBackpressure(data: ArrayBuffer): Promise<boolean> {
    const channel = this.channel
    if (channel?.readyState !== 'open') return false
    if (channel.bufferedAmount >= BUFFER_HIGH_WATER_BYTES && !await this.waitForLowBuffer(channel)) return false
    if (channel.readyState !== 'open') return false
    channel.send(data)
    return true
  }

  close(): void {
    if (this.terminal) return
    this.terminal = true
    this.clearTimers()
    this.disposePeer()
    this.setState('closed')
  }

  private async negotiate(restart: boolean): Promise<void> {
    const negotiationId = this.options.createNegotiationId?.() ?? crypto.randomUUID()
    this.resetPeer(negotiationId)
    const peer = this.ensurePeer()
    this.attachChannel(peer.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }))
    if (restart && !this.options.sendSignal({ type: 'webrtc.restart', negotiationId })) {
      this.fail()
      return
    }
    const description = await peer.createOffer(restart ? { iceRestart: true } : undefined)
    await peer.setLocalDescription(description)
    const local = peer.localDescription ?? description
    if (local.type !== 'offer' || !local.sdp || !this.options.sendSignal({
      type: 'webrtc.offer',
      negotiationId,
      description: { type: 'offer', sdp: local.sdp },
    })) {
      this.fail()
      return
    }
    this.signalReady = true
    this.flushLocalCandidates()
  }

  private async acceptOffer(message: WebRtcOfferEvent): Promise<void> {
    this.resetPeer(message.negotiationId)
    const peer = this.ensurePeer()
    await peer.setRemoteDescription(message.description)
    this.remoteDescriptionSet = true
    await this.flushRemoteCandidates()
    const description = await peer.createAnswer()
    await peer.setLocalDescription(description)
    const local = peer.localDescription ?? description
    if (local.type !== 'answer' || !local.sdp || !this.options.sendSignal({
      type: 'webrtc.answer',
      negotiationId: message.negotiationId,
      description: { type: 'answer', sdp: local.sdp },
    })) {
      this.fail()
      return
    }
    this.signalReady = true
    this.flushLocalCandidates()
  }

  private ensurePeer(): PeerConnectionLike {
    if (this.peer) return this.peer
    const configuration: RTCConfiguration = { iceServers: this.options.iceServers }
    this.peer = this.options.createPeerConnection?.(configuration)
      ?? new RTCPeerConnection(configuration) as unknown as PeerConnectionLike
    this.peer.onicecandidate = event => {
      if (!event.candidate || !this.negotiationId) return
      const candidate = event.candidate.toJSON()
      if (!this.signalReady) this.localCandidates.push(candidate)
      else this.sendIce(candidate)
    }
    this.peer.ondatachannel = event => {
      const channel = event.channel as unknown as DataChannelLike
      if (this.options.role !== 'joiner' || channel.label !== DATA_CHANNEL_LABEL || !channel.ordered) {
        channel.close()
        return
      }
      this.attachChannel(channel)
    }
    this.peer.onconnectionstatechange = () => {
      if (this.peer?.connectionState === 'failed' || this.peer?.connectionState === 'closed') this.fail()
    }
    return this.peer
  }

  private attachChannel(channel: DataChannelLike): void {
    this.channel?.close()
    this.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER_BYTES
    channel.onopen = () => {
      this.clearTimers()
      this.setState('direct')
    }
    channel.onmessage = event => this.dispatchEvent(new MessageEvent('message', { data: event.data }))
    channel.onerror = () => this.fail()
    channel.onclose = () => {
      if (!this.terminal && this.currentState === 'direct') this.fail()
    }
  }

  private waitForLowBuffer(channel: DataChannelLike): Promise<boolean> {
    if (channel.bufferedAmount <= BUFFER_LOW_WATER_BYTES) return Promise.resolve(true)
    return new Promise(resolve => {
      this.bufferWaiter = resolve
      channel.onbufferedamountlow = () => {
        channel.onbufferedamountlow = null
        this.bufferWaiter = undefined
        resolve(channel.readyState === 'open')
      }
    })
  }

  private resetPeer(negotiationId: string): void {
    this.clearTimers()
    this.disposePeer()
    this.negotiationId = negotiationId
    this.remoteCandidates = []
    this.localCandidates = []
    this.remoteDescriptionSet = false
    this.signalReady = false
    this.setState('connecting')
    this.negotiationTimer = window.setTimeout(
      () => this.fail(),
      this.options.negotiationTimeoutMs ?? 10_000,
    )
  }

  private disposePeer(): void {
    const channel = this.channel
    this.channel = undefined
    if (channel) {
      this.bufferWaiter?.(false)
      this.bufferWaiter = undefined
      channel.onopen = null
      channel.onclose = null
      channel.onerror = null
      channel.onmessage = null
      channel.onbufferedamountlow = null
      channel.close()
    }
    const peer = this.peer
    this.peer = undefined
    if (peer) {
      peer.onicecandidate = null
      peer.ondatachannel = null
      peer.onconnectionstatechange = null
      peer.close()
    }
  }

  private fail(): void {
    if (this.terminal || this.currentState === 'fallback') return
    window.clearTimeout(this.negotiationTimer)
    this.setState('fallback')
    if (this.options.role === 'creator') {
      this.restartTimer = window.setTimeout(
        () => { void this.restart() },
        this.options.restartDelayMs ?? 1_000,
      )
    }
  }

  private sendIce(candidate: RTCIceCandidateInit): void {
    if (!this.negotiationId || !candidate.candidate) return
    this.options.sendSignal({
      type: 'webrtc.ice',
      negotiationId: this.negotiationId,
      candidate: {
        candidate: candidate.candidate,
        ...(candidate.sdpMid !== undefined ? { sdpMid: candidate.sdpMid } : {}),
        ...(candidate.sdpMLineIndex !== undefined ? { sdpMLineIndex: candidate.sdpMLineIndex } : {}),
        ...(candidate.usernameFragment !== undefined ? { usernameFragment: candidate.usernameFragment } : {}),
      },
    })
  }

  private flushLocalCandidates(): void {
    for (const candidate of this.localCandidates.splice(0)) this.sendIce(candidate)
  }

  private async flushRemoteCandidates(): Promise<void> {
    const peer = this.ensurePeer()
    for (const candidate of this.remoteCandidates.splice(0)) await peer.addIceCandidate(candidate)
  }

  private clearTimers(): void {
    window.clearTimeout(this.negotiationTimer)
    window.clearTimeout(this.restartTimer)
  }

  private setState(state: PeerTransportState): void {
    if (this.currentState === state) return
    this.currentState = state
    this.dispatchEvent(new Event('statechange'))
  }
}
