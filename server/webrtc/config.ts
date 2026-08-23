import type { IceServerConfiguration, WebRtcConfigResponse } from '../../shared/protocol.js'

const DEFAULT_NEGOTIATION_TIMEOUT_MS = 10_000
const MIN_NEGOTIATION_TIMEOUT_MS = 1_000
const MAX_NEGOTIATION_TIMEOUT_MS = 30_000

export interface WebRtcEnvironment {
  WEBRTC_STUN_URLS?: string
  WEBRTC_TURN_URLS?: string
  WEBRTC_TURN_USERNAME?: string
  WEBRTC_TURN_CREDENTIAL?: string
  WEBRTC_NEGOTIATION_TIMEOUT_MS?: string
}

function parseUrls(value: string | undefined, protocols: ReadonlySet<string>, name: string): string[] {
  if (!value?.trim()) return []
  return value.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    let protocol: string
    try {
      protocol = new URL(item).protocol
    } catch {
      throw new Error(`${name} contains an invalid URL`)
    }
    if (!protocols.has(protocol)) throw new Error(`${name} contains an unsupported URL`)
    return item
  })
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_NEGOTIATION_TIMEOUT_MS
  const timeout = Number(value)
  if (!Number.isSafeInteger(timeout) || timeout < MIN_NEGOTIATION_TIMEOUT_MS || timeout > MAX_NEGOTIATION_TIMEOUT_MS) {
    throw new Error(`WEBRTC_NEGOTIATION_TIMEOUT_MS must be between ${MIN_NEGOTIATION_TIMEOUT_MS} and ${MAX_NEGOTIATION_TIMEOUT_MS}`)
  }
  return timeout
}

export function readWebRtcConfig(environment: WebRtcEnvironment): WebRtcConfigResponse {
  const stunUrls = parseUrls(environment.WEBRTC_STUN_URLS, new Set(['stun:', 'stuns:']), 'WEBRTC_STUN_URLS')
  const turnUrls = parseUrls(environment.WEBRTC_TURN_URLS, new Set(['turn:', 'turns:']), 'WEBRTC_TURN_URLS')
  const username = environment.WEBRTC_TURN_USERNAME?.trim()
  const credential = environment.WEBRTC_TURN_CREDENTIAL?.trim()
  if (turnUrls.length > 0 && (!username || !credential)) {
    throw new Error('TURN URLs require WEBRTC_TURN_USERNAME and WEBRTC_TURN_CREDENTIAL')
  }
  if (turnUrls.length === 0 && (username || credential)) {
    throw new Error('TURN credentials require WEBRTC_TURN_URLS')
  }

  const iceServers: IceServerConfiguration[] = []
  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls })
  if (turnUrls.length > 0) iceServers.push({ urls: turnUrls, username, credential })
  return { iceServers, negotiationTimeoutMs: parseTimeout(environment.WEBRTC_NEGOTIATION_TIMEOUT_MS) }
}
