import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PeerTransport } from './peer-transport.js'

class FakeDataChannel {
  readonly label = 'awindow-transfer'
  readonly ordered = true
  readyState: RTCDataChannelState = 'connecting'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  binaryType: BinaryType = 'blob'
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onbufferedamountlow: ((event: Event) => void) | null = null
  sent: unknown[] = []
  closed = false

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 'closed'
  }

  open(): void {
    this.readyState = 'open'
    this.onopen?.(new Event('open'))
  }

  drain(): void {
    this.bufferedAmount = this.bufferedAmountLowThreshold
    this.onbufferedamountlow?.(new Event('bufferedamountlow'))
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescription | null = null
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null
  onconnectionstatechange: ((event: Event) => void) | null = null
  channel = new FakeDataChannel()
  remoteDescriptions: RTCSessionDescriptionInit[] = []
  candidates: RTCIceCandidateInit[] = []
  offerOptions: (RTCOfferOptions | undefined)[] = []
  closed = false

  createDataChannel(_label: string, options?: RTCDataChannelInit): FakeDataChannel {
    expect(options).toEqual({ ordered: true })
    return this.channel
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options)
    return { type: 'offer', sdp: 'creator-offer' }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'joiner-answer' }
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescriptions.push(description)
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void> {
    if (candidate) this.candidates.push(candidate)
  }

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }
}

describe('PeerTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('creates a reliable ordered channel and sends a creator offer', async () => {
    const peer = new FakePeerConnection()
    const signals: unknown[] = []
    const transport = new PeerTransport({
      role: 'creator',
      iceServers: [{ urls: ['stun:example.com'] }],
      sendSignal: signal => { signals.push(signal); return true },
      createPeerConnection: configuration => {
        expect(configuration.iceServers).toEqual([{ urls: ['stun:example.com'] }])
        return peer
      },
      createNegotiationId: () => 'round-1',
    })

    await transport.start()
    expect(signals).toContainEqual({
      type: 'webrtc.offer',
      negotiationId: 'round-1',
      description: { type: 'offer', sdp: 'creator-offer' },
    })
    peer.channel.open()
    expect(transport.state).toBe('direct')
    expect(transport.send('encrypted')).toBe(true)
    expect(peer.channel.sent).toEqual(['encrypted'])
  })

  it('answers creator offers and applies matching ICE candidates', async () => {
    const peer = new FakePeerConnection()
    const signals: unknown[] = []
    const transport = new PeerTransport({
      role: 'joiner',
      iceServers: [],
      sendSignal: signal => { signals.push(signal); return true },
      createPeerConnection: () => peer,
    })

    await transport.handleSignal({
      type: 'webrtc.offer',
      negotiationId: 'round-1',
      description: { type: 'offer', sdp: 'creator-offer' },
      senderRole: 'creator',
    })
    await transport.handleSignal({
      type: 'webrtc.ice',
      negotiationId: 'round-1',
      candidate: { candidate: 'candidate:1' },
      senderRole: 'creator',
    })

    expect(peer.remoteDescriptions).toEqual([{ type: 'offer', sdp: 'creator-offer' }])
    expect(peer.candidates).toEqual([{ candidate: 'candidate:1' }])
    expect(signals).toContainEqual({
      type: 'webrtc.answer',
      negotiationId: 'round-1',
      description: { type: 'answer', sdp: 'joiner-answer' },
    })
  })

  it('pauses binary sends above the high water mark and resumes at the low water mark', async () => {
    const peer = new FakePeerConnection()
    const transport = new PeerTransport({
      role: 'creator',
      iceServers: [],
      sendSignal: () => true,
      createPeerConnection: () => peer,
      createNegotiationId: () => 'round-1',
    })
    await transport.start()
    peer.channel.open()
    peer.channel.bufferedAmount = 512 * 1024
    const frame = new ArrayBuffer(32)

    const sent = transport.sendWithBackpressure(frame)
    expect(peer.channel.sent).toHaveLength(0)
    expect(peer.channel.bufferedAmountLowThreshold).toBe(128 * 1024)
    peer.channel.drain()
    await expect(sent).resolves.toBe(true)
    expect(peer.channel.sent).toEqual([frame])
  })

  it('enters fallback on timeout and lets only the creator restart', async () => {
    const peers: FakePeerConnection[] = []
    const signals: { type: string }[] = []
    let sequence = 0
    const transport = new PeerTransport({
      role: 'creator',
      iceServers: [],
      negotiationTimeoutMs: 100,
      restartDelayMs: 50,
      sendSignal: signal => { signals.push(signal); return true },
      createPeerConnection: () => {
        const peer = new FakePeerConnection()
        peers.push(peer)
        return peer
      },
      createNegotiationId: () => `round-${++sequence}`,
    })

    await transport.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(transport.state).toBe('fallback')
    await vi.advanceTimersByTimeAsync(50)
    expect(signals.map(signal => signal.type)).toEqual(['webrtc.offer', 'webrtc.restart', 'webrtc.offer'])
    expect(peers[0]?.closed).toBe(true)
    expect(peers[1]?.offerOptions).toEqual([{ iceRestart: true }])
  })

  it('ignores role-invalid signals and closes all local resources', async () => {
    const peer = new FakePeerConnection()
    const signals: unknown[] = []
    const transport = new PeerTransport({
      role: 'creator',
      iceServers: [],
      sendSignal: signal => { signals.push(signal); return true },
      createPeerConnection: () => peer,
      createNegotiationId: () => 'round-1',
    })
    await transport.start()
    await transport.handleSignal({
      type: 'webrtc.offer',
      negotiationId: 'invalid',
      description: { type: 'offer', sdp: 'invalid' },
      senderRole: 'creator',
    })

    transport.close()
    await vi.runAllTimersAsync()
    expect(peer.remoteDescriptions).toEqual([])
    expect(peer.closed).toBe(true)
    expect(peer.channel.closed).toBe(true)
    expect(transport.state).toBe('closed')
    expect(signals).toHaveLength(1)
  })
})
