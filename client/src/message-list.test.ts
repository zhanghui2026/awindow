import { describe, expect, it } from 'vitest'

import type { DeviceRole } from '../../shared/protocol.js'
import { isGroupedWithPrevious, MAX_DISPLAY_MESSAGES, trimOverflow } from './message-list.js'

interface StubMessage {
  id: string
  senderRole: DeviceRole
  createdAt: number
}

function message(id: string, senderRole: DeviceRole, createdAt: number): StubMessage {
  return { id, senderRole, createdAt }
}

describe('message-list', () => {
  it('keeps messages within the display limit', () => {
    const messages = Array.from({ length: MAX_DISPLAY_MESSAGES }, (_, index) => message(`m-${index}`, 'creator', index))
    expect(trimOverflow(messages)).toEqual([])
    expect(messages).toHaveLength(MAX_DISPLAY_MESSAGES)
  })

  it('trims oldest messages from the head beyond the limit and returns them', () => {
    const messages = Array.from({ length: MAX_DISPLAY_MESSAGES + 3 }, (_, index) => message(`m-${index}`, 'creator', index))
    const removed = trimOverflow(messages)
    expect(removed.map(item => item.id)).toEqual(['m-0', 'm-1', 'm-2'])
    expect(messages).toHaveLength(MAX_DISPLAY_MESSAGES)
    expect(messages[0]?.id).toBe('m-3')
  })

  it('groups consecutive messages from the same sender within the interval', () => {
    const first = message('a', 'creator', 1_000)
    const second = message('b', 'creator', 1_000 + 119_999)
    expect(isGroupedWithPrevious(first, second)).toBe(true)
  })

  it('does not group across senders or long gaps', () => {
    const creatorMessage = message('a', 'creator', 1_000)
    const joinerMessage = message('b', 'joiner', 2_000)
    expect(isGroupedWithPrevious(creatorMessage, joinerMessage)).toBe(false)
    expect(isGroupedWithPrevious(undefined, creatorMessage)).toBe(false)
    const late = message('c', 'creator', 1_000 + 120_000)
    expect(isGroupedWithPrevious(creatorMessage, late)).toBe(false)
  })

  it('does not group out-of-order timestamps', () => {
    const later = message('a', 'creator', 5_000)
    const earlier = message('b', 'creator', 1_000)
    expect(isGroupedWithPrevious(later, earlier)).toBe(false)
  })
})
