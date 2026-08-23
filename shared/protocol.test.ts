import { describe, expect, it } from 'vitest'

import {
  MAX_ENVELOPE_CIPHERTEXT_LENGTH,
  MAX_ICE_CANDIDATE_LENGTH,
  MAX_SDP_LENGTH,
  MAX_TEXT_LENGTH,
  parseClientMessage,
  validateEncryptedEnvelope,
  validateText,
  type EncryptedEnvelope,
} from './protocol.js'

function envelope(overrides: Partial<EncryptedEnvelope> = {}): EncryptedEnvelope {
  return {
    version: 1,
    keyGeneration: 1,
    messageId: 'message-1',
    nonce: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'A'.repeat(22),
    ...overrides,
  }
}

describe('shared protocol validation', () => {
  it('enforces the plaintext text boundary before encryption', () => {
    expect(validateText('a'.repeat(MAX_TEXT_LENGTH))).toBeNull()
    expect(validateText('a'.repeat(MAX_TEXT_LENGTH + 1))?.code).toBe('TEXT_TOO_LONG')
  })

  it('validates encrypted envelope structure and exact fields', () => {
    expect(validateEncryptedEnvelope(envelope())).toBeNull()
    expect(validateEncryptedEnvelope({ ...envelope(), nonce: 'short' })?.code).toBe('MESSAGE_INVALID')
    expect(validateEncryptedEnvelope({ ...envelope(), ciphertext: `${'A'.repeat(21)}B` })?.code).toBe('MESSAGE_INVALID')
    expect(validateEncryptedEnvelope({ ...envelope(), ciphertext: 'A'.repeat(15) })?.code).toBe('MESSAGE_INVALID')
    expect(validateEncryptedEnvelope({ ...envelope(), ciphertext: 'A'.repeat(MAX_ENVELOPE_CIPHERTEXT_LENGTH + 1) })?.code)
      .toBe('MESSAGE_INVALID')
    expect(validateEncryptedEnvelope({ ...envelope(), plaintext: 'secret' })?.code).toBe('MESSAGE_INVALID')
  })

  it('parses key exchange and verification messages without extra fields', () => {
    expect(parseClientMessage({ type: 'key.exchange', publicKey: '{"kty":"EC"}', proof: 'proof' }))
      .toEqual({ type: 'key.exchange', publicKey: '{"kty":"EC"}', proof: 'proof' })
    expect(parseClientMessage({ type: 'verification.confirm', matched: true }))
      .toEqual({ type: 'verification.confirm', matched: true })
    expect(parseClientMessage({ type: 'verification.confirm', matched: true, secret: 'leak' }))
      .toMatchObject({ code: 'MESSAGE_INVALID' })
  })

  it('parses role-specific WebRTC descriptions and rejects malformed signals', () => {
    expect(parseClientMessage({
      type: 'webrtc.offer',
      negotiationId: 'round-1',
      description: { type: 'offer', sdp: 'v=0' },
    })).toMatchObject({ type: 'webrtc.offer', description: { type: 'offer' } })
    expect(parseClientMessage({
      type: 'webrtc.offer',
      negotiationId: 'round-1',
      description: { type: 'answer', sdp: 'v=0' },
    })).toMatchObject({ code: 'WEBRTC_SIGNAL_INVALID' })
    expect(parseClientMessage({
      type: 'webrtc.answer',
      negotiationId: 'round-1',
      description: { type: 'answer', sdp: 'x'.repeat(MAX_SDP_LENGTH + 1) },
    })).toMatchObject({ code: 'WEBRTC_SIGNAL_INVALID' })
  })

  it('validates ICE candidates and negotiation identifiers', () => {
    expect(parseClientMessage({
      type: 'webrtc.ice',
      negotiationId: 'round-1',
      candidate: { candidate: 'candidate:1', sdpMid: null, sdpMLineIndex: 0 },
    })).toMatchObject({ type: 'webrtc.ice', candidate: { sdpMLineIndex: 0 } })
    expect(parseClientMessage({
      type: 'webrtc.ice',
      negotiationId: 'round-1',
      candidate: { candidate: 'x'.repeat(MAX_ICE_CANDIDATE_LENGTH + 1) },
    })).toMatchObject({ code: 'WEBRTC_SIGNAL_INVALID' })
    expect(parseClientMessage({
      type: 'webrtc.ice',
      negotiationId: 'round-1',
      candidate: { candidate: 'candidate:1', sdpMLineIndex: -1 },
    })).toMatchObject({ code: 'MESSAGE_INVALID' })
  })

  it('parses encrypted fallback and retry messages', () => {
    expect(parseClientMessage({ type: 'transfer.fallback', envelope: envelope() }))
      .toMatchObject({ type: 'transfer.fallback', envelope: { messageId: 'message-1' } })
    expect(parseClientMessage({ type: 'message.retry', messageId: 'message-1' }))
      .toEqual({ type: 'message.retry', messageId: 'message-1' })
    expect(parseClientMessage({ type: 'text.send', text: 'plaintext' }))
      .toMatchObject({ code: 'MESSAGE_INVALID' })
    expect(parseClientMessage({
      type: 'image.fallback',
      transferId: '12345678-1234-4123-8123-123456789abc',
      imageId: 'image-1',
    })).toEqual({
      type: 'image.fallback',
      transferId: '12345678-1234-4123-8123-123456789abc',
      imageId: 'image-1',
    })
  })
})
