import { describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '../../shared/protocol.js'

import {
  CryptoSession,
  padImageBytes,
  padTextBytes,
  unpadBytes,
} from './crypto-session.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, length)))
  }
  return bytes
}

async function pairedSessions(roomId = 'room-1', invitationSecret = CryptoSession.generateInvitationSecret()) {
  const creator = await CryptoSession.create(roomId, 'creator', invitationSecret)
  const joiner = await CryptoSession.create(roomId, 'joiner', invitationSecret)
  const creatorSafety = await creator.establish(joiner.publicKey())
  const joinerSafety = await joiner.establish(creator.publicKey())
  return { creator, joiner, creatorSafety, joinerSafety }
}

describe('CryptoSession', () => {
  it('accepts only canonical 256-bit invitation secrets', () => {
    expect(CryptoSession.isInvitationSecret(CryptoSession.generateInvitationSecret())).toBe(true)
    expect(CryptoSession.isInvitationSecret('invalid')).toBe(false)
    expect(CryptoSession.isInvitationSecret('AQ')).toBe(false)
  })

  it('derives matching safety numbers and directional encryption keys', async () => {
    const { creator, joiner, creatorSafety, joinerSafety } = await pairedSessions()
    expect(creatorSafety).toBe(joinerSafety)
    expect(creatorSafety).toMatch(/^\d{3} \d{3} \d{3} \d{3}$/u)

    const envelope = await creator.encrypt('message-1', encoder.encode('hello'))
    expect(decoder.decode(await joiner.decrypt(envelope))).toBe('hello')

    const response = await joiner.encrypt('message-2', encoder.encode('world'))
    expect(decoder.decode(await creator.decrypt(response))).toBe('world')
  })

  it('authenticates ephemeral public keys with the QR invitation secret', async () => {
    const invitationSecret = CryptoSession.generateInvitationSecret()
    const creator = await CryptoSession.create('room-1', 'creator', invitationSecret)
    const joiner = await CryptoSession.create('room-1', 'joiner', invitationSecret)
    const proof = await joiner.publicKeyProof()

    expect(proof).toBeDefined()
    expect(await creator.verifyPublicKeyProof('joiner', joiner.publicKey(), proof!)).toBe(true)
    expect(await creator.verifyPublicKeyProof('creator', joiner.publicKey(), proof!)).toBe(false)
  })

  it('switches the creator to manual verification when the joiner has no invitation secret', async () => {
    const creator = await CryptoSession.create('room-1', 'creator', CryptoSession.generateInvitationSecret())
    const joiner = await CryptoSession.create('room-1', 'joiner')

    creator.useManualVerification()
    const creatorSafety = await creator.establish(joiner.publicKey())
    const joinerSafety = await joiner.establish(creator.publicKey())

    expect(creatorSafety).toBe(joinerSafety)
    expect((await creator.export()).invitationSecret).toBeUndefined()
  })

  it('rejects ciphertext tampering, cross-room use and nonce replay', async () => {
    const { creator, joiner } = await pairedSessions()
    const envelope = await creator.encrypt('message-1', encoder.encode('secret'))
    const tampered: EncryptedEnvelope = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.startsWith('A') ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`,
    }
    await expect(joiner.decrypt(tampered)).rejects.toThrow()

    expect(decoder.decode(await joiner.decrypt(envelope))).toBe('secret')
    await expect(joiner.decrypt(envelope)).rejects.toThrow('replayed')

    const otherJoiner = await CryptoSession.create('room-2', 'joiner', CryptoSession.generateInvitationSecret())
    await otherJoiner.establish(creator.publicKey())
    await expect(otherJoiner.decrypt(await creator.encrypt('message-2', encoder.encode('secret')))).rejects.toThrow()
  })

  it('decrypts own encrypted history and permits only identical known receive history', async () => {
    const { creator, joiner } = await pairedSessions()
    const ownEnvelope = await creator.encrypt('own-message', encoder.encode('own'))
    expect(decoder.decode(await creator.decrypt(ownEnvelope, 'creator'))).toBe('own')

    const peerEnvelope = await joiner.encrypt('peer-message', encoder.encode('peer'))
    expect(decoder.decode(await creator.decrypt(peerEnvelope))).toBe('peer')
    expect(decoder.decode(await creator.decrypt(peerEnvelope, 'joiner', true))).toBe('peer')
    const conflicting = {
      ...peerEnvelope,
      ciphertext: `${peerEnvelope.ciphertext.startsWith('A') ? 'B' : 'A'}${peerEnvelope.ciphertext.slice(1)}`,
    }
    await expect(creator.decrypt(conflicting, 'joiner', true)).rejects.toThrow('replayed')
  })

  it('restores keys and advances the persisted nonce counter', async () => {
    const { creator, joiner } = await pairedSessions()
    const first = await creator.encrypt('message-1', encoder.encode('first'))
    const restored = await CryptoSession.restore(await creator.export())
    const second = await restored.encrypt('message-2', encoder.encode('second'))

    expect(second.nonce).not.toBe(first.nonce)
    expect(decoder.decode(await joiner.decrypt(second))).toBe('second')
  })

  it('pads and unpads text and image payload boundaries', () => {
    for (const length of [0, 1, 1020, 1021, 4092, 4093, 16_380, 16_381]) {
      const input = randomBytes(length)
      const padded = padTextBytes(input)
      expect(Array.from(unpadBytes(padded))).toEqual(Array.from(input))
      expect(padded.length % 1024).toBe(0)
    }

    for (const length of [1, 65_531, 65_532, 65_536, 131_071]) {
      const input = randomBytes(length)
      const padded = padImageBytes(input)
      expect(Array.from(unpadBytes(padded))).toEqual(Array.from(input))
      expect(padded.length % (64 * 1024)).toBe(0)
    }
  })

  it('clears established keys when destroyed', async () => {
    const { creator } = await pairedSessions()
    creator.destroy()
    await expect(creator.encrypt('message-1', encoder.encode('secret'))).rejects.toThrow('not established')
  })
})
