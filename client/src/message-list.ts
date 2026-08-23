import type { DeviceRole } from '../../shared/protocol.js'

export const MAX_DISPLAY_MESSAGES = 200
export const MESSAGE_GROUP_INTERVAL_MS = 120_000

export interface DisplayMessageLike {
  id: string
  senderRole: DeviceRole
  createdAt: number
}

export function trimOverflow<T extends DisplayMessageLike>(messages: T[], limit: number = MAX_DISPLAY_MESSAGES): T[] {
  if (messages.length <= limit) return []
  return messages.splice(0, messages.length - limit)
}

export function isGroupedWithPrevious(previous: DisplayMessageLike | undefined, current: DisplayMessageLike): boolean {
  if (!previous) return false
  if (previous.senderRole !== current.senderRole) return false
  const gap = current.createdAt - previous.createdAt
  return gap >= 0 && gap < MESSAGE_GROUP_INTERVAL_MS
}
