import type { DeviceRole, EncryptedEnvelope } from '../../shared/protocol.js'

export type CryptoRole = DeviceRole

export interface StoredCryptoSession {
  version: 1
  roomId: string
  role: CryptoRole
  invitationSecret?: string
  privateKey: JsonWebKey
  publicKey: JsonWebKey
  peerPublicKey?: string
  keyGeneration: number
  noncePrefix: string
  sendCounter: string
  receivedNonces: string[]
  receivedEnvelopes?: Record<string, string>
}

const encoder = new TextEncoder()
const textBuckets = [1024, 4096, 16 * 1024]
const imageBlockBytes = 64 * 1024

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function concatBytes(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function serializePublicKey(key: JsonWebKey): string {
  if (!key.x || !key.y) throw new Error('Invalid ECDH public key')
  return encodeBase64Url(encoder.encode(JSON.stringify({ crv: 'P-256', kty: 'EC', x: key.x, y: key.y })))
}

function parsePublicKey(value: string): JsonWebKey {
  const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as JsonWebKey
  if (parsed.kty !== 'EC' || parsed.crv !== 'P-256' || !parsed.x || !parsed.y) {
    throw new Error('Invalid ECDH public key')
  }
  return parsed
}

function peerRole(role: CryptoRole): CryptoRole {
  return role === 'creator' ? 'joiner' : 'creator'
}

function paddedSize(length: number, buckets: readonly number[]): number {
  const required = length + 4
  return buckets.find(bucket => bucket >= required) ?? Math.ceil(required / imageBlockBytes) * imageBlockBytes
}

export function padTextBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return padBytes(bytes, paddedSize(bytes.length, textBuckets))
}

export function padImageBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return padBytes(bytes, paddedSize(bytes.length, []))
}

export function padBytes(bytes: Uint8Array, targetLength: number): Uint8Array<ArrayBuffer> {
  if (targetLength < bytes.length + 4) throw new Error('Padding target is too small')
  const padded = new Uint8Array(targetLength)
  new DataView(padded.buffer).setUint32(0, bytes.length)
  padded.set(bytes, 4)
  for (let offset = bytes.length + 4; offset < targetLength; offset += 65_536) {
    crypto.getRandomValues(padded.subarray(offset, Math.min(offset + 65_536, targetLength)))
  }
  return padded
}

export function unpadBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.length < 4) throw new Error('Invalid padded payload')
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (length > bytes.length - 4) throw new Error('Invalid padded payload')
  return bytes.slice(4, length + 4)
}

export class CryptoSession {
  private sendKey?: CryptoKey
  private receiveKey?: CryptoKey
  private keyFingerprint?: string
  private peerPublicKey?: string
  private sendCounter: bigint
  private readonly receivedNonces: Set<string>
  private readonly receivedEnvelopes: Map<string, string>

  private constructor(
    readonly roomId: string,
    readonly role: CryptoRole,
    private readonly keyPair: CryptoKeyPair,
    private readonly publicKeyJwk: JsonWebKey,
    private invitationSecret: string | undefined,
    private readonly keyGeneration: number,
    private readonly noncePrefix: Uint8Array<ArrayBuffer>,
    sendCounter = 0n,
    receivedNonces: string[] = [],
    receivedEnvelopes: Record<string, string> = {},
  ) {
    this.sendCounter = sendCounter
    this.receivedNonces = new Set(receivedNonces)
    this.receivedEnvelopes = new Map(Object.entries(receivedEnvelopes))
  }

  static generateInvitationSecret(): string {
    return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  }

  static isInvitationSecret(value: string): boolean {
    try {
      const decoded = decodeBase64Url(value)
      return decoded.length === 32 && encodeBase64Url(decoded) === value
    } catch {
      return false
    }
  }

  static async create(
    roomId: string,
    role: CryptoRole,
    invitationSecret?: string,
  ): Promise<CryptoSession> {
    if (invitationSecret && !CryptoSession.isInvitationSecret(invitationSecret)) {
      throw new Error('Invalid invitation secret')
    }
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    )
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    return new CryptoSession(
      roomId,
      role,
      keyPair,
      publicKeyJwk,
      invitationSecret,
      1,
      crypto.getRandomValues(new Uint8Array(4)),
    )
  }

  static async restore(state: StoredCryptoSession): Promise<CryptoSession> {
    if (state.version !== 1 || state.keyGeneration < 1) throw new Error('Unsupported crypto session')
    if (state.invitationSecret && !CryptoSession.isInvitationSecret(state.invitationSecret)) {
      throw new Error('Invalid invitation secret')
    }
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      state.privateKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    )
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      state.publicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      [],
    )
    const session = new CryptoSession(
      state.roomId,
      state.role,
      { privateKey, publicKey },
      state.publicKey,
      state.invitationSecret,
      state.keyGeneration,
      decodeBase64Url(state.noncePrefix),
      BigInt(state.sendCounter),
      state.receivedNonces,
      state.receivedEnvelopes,
    )
    if (state.peerPublicKey) await session.establish(state.peerPublicKey)
    return session
  }

  publicKey(): string {
    return serializePublicKey(this.publicKeyJwk)
  }

  async publicKeyProof(): Promise<string | undefined> {
    if (!this.invitationSecret) return undefined
    const key = await crypto.subtle.importKey(
      'raw',
      decodeBase64Url(this.invitationSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const proof = await crypto.subtle.sign('HMAC', key, this.publicKeyProofPayload(this.role, this.publicKey()))
    return encodeBase64Url(new Uint8Array(proof))
  }

  async verifyPublicKeyProof(role: CryptoRole, publicKey: string, proof: string): Promise<boolean> {
    if (!this.invitationSecret) return false
    const key = await crypto.subtle.importKey(
      'raw',
      decodeBase64Url(this.invitationSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return crypto.subtle.verify(
      'HMAC',
      key,
      decodeBase64Url(proof),
      this.publicKeyProofPayload(role, publicKey),
    )
  }

  useManualVerification(): void {
    this.invitationSecret = undefined
  }

  async establish(publicKey: string): Promise<string> {
    const importedPeerKey = await crypto.subtle.importKey(
      'jwk',
      parsePublicKey(publicKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )
    const sharedSecret = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: importedPeerKey },
      this.keyPair.privateKey,
      256,
    )
    const creatorPublicKey = this.role === 'creator' ? this.publicKey() : publicKey
    const joinerPublicKey = this.role === 'joiner' ? this.publicKey() : publicKey
    const transcript = encoder.encode(`${this.roomId}\0${creatorPublicKey}\0${joinerPublicKey}`)
    const salt = this.invitationSecret
      ? decodeBase64Url(this.invitationSecret)
      : new Uint8Array(await crypto.subtle.digest('SHA-256', transcript))
    const material = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey', 'deriveBits'])
    const deriveKey = (direction: string) => crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: concatBytes(transcript, encoder.encode(`\0${direction}`)) },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
    this.sendKey = await deriveKey(`${this.role}-to-${peerRole(this.role)}`)
    this.receiveKey = await deriveKey(`${peerRole(this.role)}-to-${this.role}`)
    const fingerprintBytes = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: concatBytes(transcript, encoder.encode('\0key-fingerprint')) },
      material,
      64,
    ))
    const fingerprintHex = Array.from(fingerprintBytes, byte => byte.toString(16).padStart(2, '0')).join('')
    this.keyFingerprint = (fingerprintHex.match(/.{1,4}/gu) ?? []).join(' ')
    this.peerPublicKey = publicKey
    return this.keyFingerprint
  }

  fingerprint(): string | undefined {
    return this.keyFingerprint
  }

  async encrypt(messageId: string, plaintext: Uint8Array<ArrayBuffer>): Promise<EncryptedEnvelope> {
    if (!this.sendKey) throw new Error('Crypto session is not established')
    const nonce = this.nextNonce()
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: this.additionalData(this.role, messageId) },
      this.sendKey,
      plaintext,
    )
    return {
      version: 1,
      keyGeneration: this.keyGeneration,
      messageId,
      nonce: encodeBase64Url(nonce),
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    }
  }

  async decrypt(
    envelope: EncryptedEnvelope,
    senderRole: CryptoRole = peerRole(this.role),
    allowKnownEnvelope = false,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const key = senderRole === this.role ? this.sendKey : this.receiveKey
    if (!key) throw new Error('Crypto session is not established')
    if (envelope.version !== 1 || envelope.keyGeneration !== this.keyGeneration) {
      throw new Error('Unsupported encrypted envelope')
    }
    const fingerprint = this.envelopeFingerprint(envelope)
    const knownFingerprint = this.receivedEnvelopes.get(envelope.nonce)
    if (senderRole !== this.role && this.receivedNonces.has(envelope.nonce)) {
      if (!allowKnownEnvelope || knownFingerprint !== fingerprint) throw new Error('Encrypted envelope replayed')
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decodeBase64Url(envelope.nonce),
        additionalData: this.additionalData(senderRole, envelope.messageId),
      },
      key,
      decodeBase64Url(envelope.ciphertext),
    )
    if (senderRole !== this.role) {
      this.receivedNonces.add(envelope.nonce)
      this.receivedEnvelopes.set(envelope.nonce, fingerprint)
    }
    return new Uint8Array(plaintext)
  }

  async export(): Promise<StoredCryptoSession> {
    return {
      version: 1,
      roomId: this.roomId,
      role: this.role,
      invitationSecret: this.invitationSecret,
      privateKey: await crypto.subtle.exportKey('jwk', this.keyPair.privateKey),
      publicKey: this.publicKeyJwk,
      peerPublicKey: this.peerPublicKey,
      keyGeneration: this.keyGeneration,
      noncePrefix: encodeBase64Url(this.noncePrefix),
      sendCounter: this.sendCounter.toString(),
      receivedNonces: Array.from(this.receivedNonces),
      receivedEnvelopes: Object.fromEntries(this.receivedEnvelopes),
    }
  }

  destroy(): void {
    this.sendKey = undefined
    this.receiveKey = undefined
    this.keyFingerprint = undefined
    this.peerPublicKey = undefined
    this.invitationSecret = undefined
    this.receivedNonces.clear()
    this.receivedEnvelopes.clear()
  }

  private nextNonce(): Uint8Array<ArrayBuffer> {
    if (this.sendCounter === 0xffff_ffff_ffff_ffffn) throw new Error('Encryption nonce exhausted')
    const nonce = new Uint8Array(12)
    nonce.set(this.noncePrefix)
    new DataView(nonce.buffer).setBigUint64(4, this.sendCounter)
    this.sendCounter += 1n
    return nonce
  }

  private additionalData(senderRole: CryptoRole, messageId: string): Uint8Array<ArrayBuffer> {
    return encoder.encode(`awindow\0v1\0${this.roomId}\0${senderRole}\0${this.keyGeneration}\0${messageId}`)
  }

  private envelopeFingerprint(envelope: EncryptedEnvelope): string {
    return `${envelope.version}\0${envelope.keyGeneration}\0${envelope.messageId}\0${envelope.nonce}\0${envelope.ciphertext}`
  }

  private publicKeyProofPayload(role: CryptoRole, publicKey: string): Uint8Array<ArrayBuffer> {
    return encoder.encode(`awindow-key\0v1\0${this.roomId}\0${role}\0${publicKey}`)
  }
}
