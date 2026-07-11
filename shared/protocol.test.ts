import { describe, expect, it } from 'vitest'

import {
  MAX_TEXT_LENGTH,
  MAX_IMAGE_BYTES,
  isSupportedImageType,
  parseClientMessage,
  validateText,
  validateImageUpload,
} from './protocol.js'

describe('shared protocol validation', () => {
  it('accepts supported image MIME types', () => {
    expect(isSupportedImageType('image/jpeg')).toBe(true)
    expect(isSupportedImageType('image/png')).toBe(true)
    expect(isSupportedImageType('image/svg+xml')).toBe(false)
  })

  it('rejects empty and whitespace-only text', () => {
    expect(validateText('')?.code).toBe('TEXT_EMPTY')
    expect(validateText('   ')?.code).toBe('TEXT_EMPTY')
    expect(validateText(null)?.code).toBe('TEXT_EMPTY')
  })

  it('enforces the text length boundary', () => {
    expect(validateText('a'.repeat(MAX_TEXT_LENGTH))).toBeNull()
    expect(validateText('a'.repeat(MAX_TEXT_LENGTH + 1))?.code).toBe('TEXT_TOO_LONG')
  })

  it('parses supported client messages and rejects malformed input', () => {
    expect(parseClientMessage({
      type: 'text.send',
      clientMessageId: 'message-1',
      text: 'hello',
    })).toMatchObject({ type: 'text.send', text: 'hello' })
    expect(parseClientMessage({ type: 'unknown' })).toMatchObject({ code: 'MESSAGE_INVALID' })
  })

  it('enforces image type and size boundaries', () => {
    expect(validateImageUpload('image/png', 1)).toBeNull()
    expect(validateImageUpload('image/gif', MAX_IMAGE_BYTES)).toBeNull()
    expect(validateImageUpload('image/svg+xml', 100)?.code).toBe('IMAGE_TYPE_UNSUPPORTED')
    expect(validateImageUpload('image/png', MAX_IMAGE_BYTES + 1)?.code).toBe('IMAGE_TOO_LARGE')
    expect(validateImageUpload('image/png', 0)?.code).toBe('IMAGE_TOO_LARGE')
  })

  it('parses valid image messages', () => {
    expect(parseClientMessage({
      type: 'image.send',
      clientMessageId: 'image-message-1',
      image: {
        imageId: 'image-1',
        fileName: 'photo.png',
        mimeType: 'image/png',
        size: 4,
      },
    })).toMatchObject({ type: 'image.send', image: { imageId: 'image-1' } })
  })
})
