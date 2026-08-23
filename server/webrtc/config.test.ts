import { describe, expect, it } from 'vitest'

import { readWebRtcConfig } from './config.js'

describe('WebRTC environment configuration', () => {
  it('parses STUN, TURN and negotiation timeout settings', () => {
    expect(readWebRtcConfig({
      WEBRTC_STUN_URLS: 'stun:one.example.com, stuns:two.example.com',
      WEBRTC_TURN_URLS: 'turn:turn.example.com,turns:secure.example.com',
      WEBRTC_TURN_USERNAME: 'device',
      WEBRTC_TURN_CREDENTIAL: 'secret',
      WEBRTC_NEGOTIATION_TIMEOUT_MS: '8000',
    })).toEqual({
      iceServers: [
        { urls: ['stun:one.example.com', 'stuns:two.example.com'] },
        { urls: ['turn:turn.example.com', 'turns:secure.example.com'], username: 'device', credential: 'secret' },
      ],
      negotiationTimeoutMs: 8_000,
    })
  })

  it('uses an empty ICE list and a ten second timeout by default', () => {
    expect(readWebRtcConfig({})).toEqual({ iceServers: [], negotiationTimeoutMs: 10_000 })
  })

  it('rejects unsupported URLs and incomplete TURN credentials', () => {
    expect(() => readWebRtcConfig({ WEBRTC_STUN_URLS: 'https://example.com' })).toThrow('unsupported URL')
    expect(() => readWebRtcConfig({ WEBRTC_TURN_URLS: 'turn:turn.example.com' })).toThrow('require WEBRTC_TURN_USERNAME')
    expect(() => readWebRtcConfig({ WEBRTC_TURN_USERNAME: 'device' })).toThrow('require WEBRTC_TURN_URLS')
    expect(() => readWebRtcConfig({ WEBRTC_NEGOTIATION_TIMEOUT_MS: '500' })).toThrow('must be between')
  })
})
