import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CryptoSession } from './crypto-session.js'
import {
  encodeEncryptedFrame,
  IMAGE_PADDED_CHUNK_BYTES,
  parseEncryptedFrame,
  TransferProtocol,
  type TransferImageEvent,
  type TransferTextEvent,
} from './transfer-protocol.js'

async function pairedSessions() {
  const invitationSecret = CryptoSession.generateInvitationSecret()
  const creator = await CryptoSession.create('room-1', 'creator', invitationSecret)
  const joiner = await CryptoSession.create('room-1', 'joiner', invitationSecret)
  await creator.establish(joiner.publicKey())
  await joiner.establish(creator.publicKey())
  return { creator, joiner }
}

describe('TransferProtocol', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('strictly parses encrypted DataChannel frames', async () => {
    const { creator } = await pairedSessions()
    const envelope = await creator.encrypt('message-1', new Uint8Array([1, 2, 3]))
    expect(parseEncryptedFrame(encodeEncryptedFrame(envelope))).toEqual(envelope)
    expect(parseEncryptedFrame(JSON.stringify({ type: 'transfer.encrypted', envelope, plaintext: 'secret' }))).toBeUndefined()
    expect(parseEncryptedFrame(JSON.stringify({ type: 'unknown', envelope }))).toBeUndefined()
    expect(parseEncryptedFrame(new ArrayBuffer(4))).toBeUndefined()
  })

  it('sends encrypted text directly and completes after an encrypted acknowledgement', async () => {
    const { creator, joiner } = await pairedSessions()
    const creatorFrames: string[] = []
    const joinerFrames: string[] = []
    const creatorTexts: TransferTextEvent[] = []
    const joinerTexts: TransferTextEvent[] = []
    let sequence = 0
    const creatorProtocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: frame => { creatorFrames.push(frame); return true },
      sendFallback: () => true,
      onText: event => creatorTexts.push(event),
      createMessageId: () => `creator-${++sequence}`,
    })
    const joinerProtocol = new TransferProtocol({
      cryptoSession: joiner,
      sendDirect: frame => { joinerFrames.push(frame); return true },
      sendFallback: () => true,
      onText: event => joinerTexts.push(event),
      createMessageId: () => `joiner-${++sequence}`,
    })

    const messageId = await creatorProtocol.sendText('端到端文字')
    expect(creatorTexts).toHaveLength(1)
    expect(creatorFrames[0]).not.toContain('端到端文字')
    await joinerProtocol.handleDirect(creatorFrames[0])
    expect(joinerTexts).toMatchObject([{ messageId, text: '端到端文字', senderRole: 'creator' }])
    await creatorProtocol.handleDirect(joinerFrames[0])

    await vi.advanceTimersByTimeAsync(10_000)
    expect(creatorFrames).toHaveLength(1)
  })

  it('retries the identical envelope once and then uses fallback', async () => {
    const { creator } = await pairedSessions()
    const directFrames: string[] = []
    const fallbackEnvelopes: unknown[] = []
    const protocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: frame => { directFrames.push(frame); return true },
      sendFallback: envelope => { fallbackEnvelopes.push(envelope); return true },
      onText: () => undefined,
      acknowledgementTimeoutMs: 100,
      createMessageId: () => 'message-1',
    })

    await protocol.sendText('retry me')
    await vi.advanceTimersByTimeAsync(100)
    expect(directFrames).toHaveLength(2)
    expect(directFrames[1]).toBe(directFrames[0])
    await vi.advanceTimersByTimeAsync(100)
    expect(fallbackEnvelopes).toEqual([parseEncryptedFrame(directFrames[0])])
  })

  it('deduplicates the same envelope across direct and fallback paths and repeats acknowledgement', async () => {
    const { creator, joiner } = await pairedSessions()
    const creatorFrames: string[] = []
    const acknowledgements: string[] = []
    const fallbackAcknowledgements: unknown[] = []
    const texts: TransferTextEvent[] = []
    let acknowledgementSequence = 0
    const creatorProtocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: frame => { creatorFrames.push(frame); return true },
      sendFallback: () => true,
      onText: () => undefined,
      createMessageId: () => 'message-1',
    })
    const joinerProtocol = new TransferProtocol({
      cryptoSession: joiner,
      sendDirect: frame => { acknowledgements.push(frame); return true },
      sendFallback: envelope => { fallbackAcknowledgements.push(envelope); return true },
      onText: event => texts.push(event),
      createMessageId: () => `ack-${++acknowledgementSequence}`,
    })

    await creatorProtocol.sendText('once')
    const envelope = parseEncryptedFrame(creatorFrames[0])!
    await joinerProtocol.handleDirect(creatorFrames[0])
    await joinerProtocol.handleFallback({
      id: 'server-record',
      senderRole: 'creator',
      envelope,
      createdAt: Date.now(),
    })

    expect(texts).toHaveLength(1)
    expect(acknowledgements).toHaveLength(1)
    expect(fallbackAcknowledgements).toHaveLength(1)
  })

  it('falls back immediately when the direct channel is unavailable or closes', async () => {
    const { creator } = await pairedSessions()
    const fallbacks: unknown[] = []
    const protocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: () => false,
      sendFallback: envelope => { fallbacks.push(envelope); return true },
      onText: () => undefined,
      createMessageId: () => 'message-1',
    })

    await protocol.sendText('fallback')
    expect(fallbacks).toHaveLength(1)
    protocol.handleTransportState('closed')
    expect(fallbacks).toHaveLength(2)
  })

  it('encrypts, chunks, reassembles, and verifies a direct image', async () => {
    const { creator, joiner } = await pairedSessions()
    const controlFrames: string[] = []
    const binaryFrames: ArrayBuffer[] = []
    const receivedImages: TransferImageEvent[] = []
    const progress: number[] = []
    const transferId = '12345678-1234-4123-8123-123456789abc'
    const creatorProtocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: frame => { controlFrames.push(frame); return true },
      sendDirectBinary: async frame => { binaryFrames.push(frame); return true },
      sendFallback: () => true,
      onText: () => undefined,
      onImage: () => undefined,
      onImageProgress: event => progress.push(event.transferredBytes),
      createMessageId: () => transferId,
    })
    const joinerProtocol = new TransferProtocol({
      cryptoSession: joiner,
      sendDirect: () => true,
      sendFallback: () => true,
      onText: () => undefined,
      onImage: event => receivedImages.push(event),
      createMessageId: () => 'ack-1',
    })
    const bytes = Uint8Array.from({ length: 32 * 1024 + 17 }, (_, index) => index % 251)
    const file = new File([bytes], 'sample.png', { type: 'image/png' })

    await creatorProtocol.sendImage(file)
    expect(controlFrames).toHaveLength(2)
    expect(controlFrames.join('')).not.toContain('sample.png')
    expect(binaryFrames).toHaveLength(2)
    expect(binaryFrames.every(frame => frame.byteLength === 32 + IMAGE_PADDED_CHUNK_BYTES + 16)).toBe(true)
    expect(progress).toEqual([32 * 1024, bytes.length])
    await joinerProtocol.handleDirect(controlFrames[0])
    await joinerProtocol.handleDirect(binaryFrames[0])
    await joinerProtocol.handleDirect(binaryFrames[1])
    await joinerProtocol.handleDirect(controlFrames[1])

    expect(receivedImages).toHaveLength(1)
    expect(receivedImages[0]).toMatchObject({ fileName: 'sample.png', mimeType: 'image/png', messageId: transferId })
    expect(receivedImages[0]?.bytes).toEqual(bytes)
  })

  it('discards an image when an encrypted chunk is tampered with', async () => {
    const { creator, joiner } = await pairedSessions()
    const controlFrames: string[] = []
    const binaryFrames: ArrayBuffer[] = []
    const images: TransferImageEvent[] = []
    const errors: Error[] = []
    const creatorProtocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: frame => { controlFrames.push(frame); return true },
      sendDirectBinary: async frame => { binaryFrames.push(frame); return true },
      sendFallback: () => true,
      onText: () => undefined,
      createMessageId: () => '12345678-1234-4123-8123-123456789abc',
    })
    const joinerProtocol = new TransferProtocol({
      cryptoSession: joiner,
      sendDirect: () => true,
      sendFallback: () => true,
      onText: () => undefined,
      onImage: event => images.push(event),
      onError: error => errors.push(error),
    })
    await creatorProtocol.sendImage(new File([new Uint8Array([1, 2, 3])], 'sample.png', { type: 'image/png' }))
    const tampered = binaryFrames[0]!.slice(0)
    const tamperedBytes = new Uint8Array(tampered)
    tamperedBytes[40] = (tamperedBytes[40] ?? 0) ^ 1

    await joinerProtocol.handleDirect(controlFrames[0])
    await joinerProtocol.handleDirect(tampered)
    await joinerProtocol.handleDirect(controlFrames[1])

    expect(images).toHaveLength(0)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('restores an encrypted image through HTTP fallback', async () => {
    const { creator, joiner } = await pairedSessions()
    const images: TransferImageEvent[] = []
    const transferId = '12345678-1234-4123-8123-123456789abc'
    let fallbackBytes: Uint8Array<ArrayBuffer> | undefined
    const creatorProtocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: () => false,
      sendFallback: () => true,
      sendImageFallback: async (_id, bytes) => { fallbackBytes = bytes },
      onText: () => undefined,
      createMessageId: () => transferId,
    })
    const joinerProtocol = new TransferProtocol({
      cryptoSession: joiner,
      sendDirect: () => true,
      sendFallback: () => true,
      onText: () => undefined,
      onImage: image => images.push(image),
      createMessageId: () => 'ack-1',
    })
    const source = Uint8Array.from({ length: IMAGE_PADDED_CHUNK_BYTES + 9 }, (_, index) => index % 239)

    await creatorProtocol.sendImage(new File([source], 'fallback.png', { type: 'image/png' }))
    expect(fallbackBytes).toBeDefined()
    await joinerProtocol.handleImageFallback(fallbackBytes!.buffer, 'creator', Date.now(), transferId)

    expect(images).toHaveLength(1)
    expect(images[0]?.bytes).toEqual(source)
  })

  it('deduplicates an image delivered by direct and fallback paths', async () => {
    const { creator, joiner } = await pairedSessions()
    const controlFrames: string[] = []
    const binaryFrames: ArrayBuffer[] = []
    const images: TransferImageEvent[] = []
    let fallbackBytes: Uint8Array<ArrayBuffer> | undefined
    const transferId = '12345678-1234-4123-8123-123456789abc'
    const creatorProtocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: frame => { controlFrames.push(frame); return true },
      sendDirectBinary: async frame => { binaryFrames.push(frame); return true },
      sendFallback: () => true,
      sendImageFallback: async (_id, bytes) => { fallbackBytes = bytes },
      onText: () => undefined,
      acknowledgementTimeoutMs: 100,
      createMessageId: () => transferId,
    })
    const joinerProtocol = new TransferProtocol({
      cryptoSession: joiner,
      sendDirect: () => true,
      sendFallback: () => true,
      onText: () => undefined,
      onImage: image => images.push(image),
      createMessageId: () => 'ack-1',
    })

    await creatorProtocol.sendImage(new File([new Uint8Array([1, 2, 3])], 'once.png', { type: 'image/png' }))
    await vi.advanceTimersByTimeAsync(100)
    await joinerProtocol.handleDirect(controlFrames[0])
    await joinerProtocol.handleDirect(binaryFrames[0])
    await joinerProtocol.handleDirect(controlFrames[1])
    await joinerProtocol.handleImageFallback(fallbackBytes!.buffer, 'creator', Date.now(), transferId)

    expect(images).toHaveLength(1)
  })

  it('exchanges resume state on direct channel recovery and clears confirmed pending text', async () => {
    const { creator, joiner } = await pairedSessions()
    const creatorFrames: string[] = []
    const joinerFrames: string[] = []
    const creatorProtocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: frame => { creatorFrames.push(frame); return true },
      sendFallback: () => true,
      onText: () => undefined,
      createMessageId: () => 'message-1',
    })
    const joinerProtocol = new TransferProtocol({
      cryptoSession: joiner,
      sendDirect: frame => { joinerFrames.push(frame); return true },
      sendFallback: () => true,
      onText: () => undefined,
      createMessageId: () => 'ack-1',
    })

    await creatorProtocol.sendText('before disconnect')
    expect(creatorFrames).toHaveLength(1)
    await joinerProtocol.handleDirect(creatorFrames[0])
    expect(joinerFrames).toHaveLength(1)
    await creatorProtocol.handleDirect(joinerFrames[0])
    expect(creatorFrames).toHaveLength(1)

    await creatorProtocol.handleTransportState('closed')
    await creatorProtocol.handleTransportState('direct')
    await joinerProtocol.handleTransportState('direct')

    expect(creatorFrames.length).toBeGreaterThanOrEqual(2)
    expect(joinerFrames.length).toBeGreaterThanOrEqual(2)

    const creatorResumeFrame = creatorFrames[creatorFrames.length - 1]
    const joinerResumeFrame = joinerFrames[joinerFrames.length - 1]
    expect(parseEncryptedFrame(creatorResumeFrame)).toBeDefined()
    expect(parseEncryptedFrame(joinerResumeFrame)).toBeDefined()

    await joinerProtocol.handleDirect(creatorResumeFrame)
    await creatorProtocol.handleDirect(joinerResumeFrame)
  })

  it('retransmits missing image chunks after resume and completes the image once', async () => {
    const { creator, joiner } = await pairedSessions()
    const controlFrames: string[] = []
    const joinerFrames: string[] = []
    const binaryFrames: ArrayBuffer[] = []
    const images: TransferImageEvent[] = []
    const transferId = '22334455-1234-4234-8234-123456789abc'
    const creatorProtocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: frame => { controlFrames.push(frame); return true },
      sendDirectBinary: async frame => { binaryFrames.push(frame); return true },
      sendFallback: () => true,
      onText: () => undefined,
      onImage: () => undefined,
      createMessageId: () => transferId,
    })
    const joinerProtocol = new TransferProtocol({
      cryptoSession: joiner,
      sendDirect: frame => { joinerFrames.push(frame); return true },
      sendFallback: () => true,
      onText: () => undefined,
      onImage: image => images.push(image),
      createMessageId: () => 'ack-1',
    })
    const bytes = Uint8Array.from({ length: 2 * 32 * 1024 + 5 }, (_, index) => index % 251)

    await creatorProtocol.sendImage(new File([bytes], 'resume.png', { type: 'image/png' }))
    expect(binaryFrames).toHaveLength(3)
    await joinerProtocol.handleDirect(controlFrames[0])
    await joinerProtocol.handleDirect(binaryFrames[0])
    await joinerProtocol.handleDirect(binaryFrames[2])
    await joinerProtocol.handleDirect(controlFrames[1])
    expect(images).toHaveLength(0)

    creatorProtocol.handleTransportState('closed')
    await creatorProtocol.handleTransportState('direct')
    await joinerProtocol.handleTransportState('direct')

    const creatorResume = controlFrames[controlFrames.length - 1]
    const joinerResume = joinerFrames[joinerFrames.length - 1]
    expect(parseEncryptedFrame(creatorResume)).toBeDefined()
    expect(parseEncryptedFrame(joinerResume)).toBeDefined()

    const binaryBeforeResume = binaryFrames.length
    await joinerProtocol.handleDirect(creatorResume)
    await creatorProtocol.handleDirect(joinerResume)

    expect(binaryFrames.length).toBeGreaterThan(binaryBeforeResume)
    await joinerProtocol.handleDirect(binaryFrames[binaryFrames.length - 1])
    await joinerProtocol.handleDirect(controlFrames[controlFrames.length - 1])

    expect(images).toHaveLength(1)
    expect(images[0]?.bytes).toEqual(bytes)
  })

  it('falls back an image immediately when the direct channel is unavailable', async () => {
    const { creator } = await pairedSessions()
    const fallbackBytes: Uint8Array<ArrayBuffer>[] = []
    const transferId = '32323232-3232-4232-8232-323232323232'
    const creatorProtocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: () => false,
      sendFallback: () => true,
      sendImageFallback: async (_id, bytes) => { fallbackBytes.push(bytes) },
      onText: () => undefined,
      onImage: () => undefined,
      createMessageId: () => transferId,
    })
    const source = Uint8Array.from({ length: 40_000 }, (_, index) => index % 239)

    await creatorProtocol.sendImage(new File([source], 'unavailable.png', { type: 'image/png' }))
    expect(fallbackBytes).toHaveLength(1)
  })

  it('falls back all pending images when the direct channel closes', async () => {
    const { creator } = await pairedSessions()
    const fallbackBytes: Uint8Array<ArrayBuffer>[] = []
    const transferId = '34343434-3434-4434-8434-343434343434'
    const creatorProtocol = new TransferProtocol({
      cryptoSession: creator,
      sendDirect: () => true,
      sendDirectBinary: async frame => { return (void frame, true) },
      sendFallback: () => true,
      sendImageFallback: async (_id, bytes) => { fallbackBytes.push(bytes) },
      onText: () => undefined,
      onImage: () => undefined,
      createMessageId: () => transferId,
    })
    const source = Uint8Array.from({ length: 40_000 }, (_, index) => index % 239)

    await creatorProtocol.sendImage(new File([source], 'pending.png', { type: 'image/png' }))
    expect(fallbackBytes).toHaveLength(0)

    await creatorProtocol.handleTransportState('closed')
    expect(fallbackBytes).toHaveLength(1)
  })
})
