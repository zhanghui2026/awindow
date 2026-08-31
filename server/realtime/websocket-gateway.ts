import type { FastifyInstance } from 'fastify'
import { WebSocket, WebSocketServer } from 'ws'

import {
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  parseClientMessage,
  parseSessionAuthMessage,
  type ApiError,
  type DeviceRole,
  type MessageDeliverEvent,
  type ServerMessage,
} from '../../shared/protocol.js'
import { RoomError } from '../rooms/errors.js'
import type { RoomService } from '../rooms/room-service.js'
import { RateLimiter } from '../security/rate-limiter.js'

interface ConnectionContext {
  roomId: string
  deviceToken: string
  deviceId: string
  role: DeviceRole
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function errorEvent(error: ApiError): ServerMessage {
  return { type: 'error', error }
}

export function registerWebSocketGateway(
  app: FastifyInstance,
  roomService: RoomService,
  now?: () => number,
): void {
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES })
  const connections = new Map<string, WebSocket>()

  const connectionKey = (roomId: string, deviceId: string) => `${roomId}:${deviceId}`
  const broadcast = (roomId: string, message: ServerMessage, exceptDeviceId?: string) => {
    for (const [key, socket] of connections) {
      if (key.startsWith(`${roomId}:`) && key !== connectionKey(roomId, exceptDeviceId ?? '')) {
        send(socket, message)
      }
    }
  }
  const sendToPeer = (roomId: string, deviceId: string, message: ServerMessage) => {
    for (const [key, socket] of connections) {
      if (key.startsWith(`${roomId}:`) && key !== connectionKey(roomId, deviceId)) send(socket, message)
    }
  }

  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') return
    server.handleUpgrade(request, socket, head, (webSocket) => {
      server.emit('connection', webSocket, request)
    })
  })

  const initializeConnection = (socket: WebSocket, context: ConnectionContext): void => {
    const key = connectionKey(context.roomId, context.deviceId)
    const messageLimiter = new RateLimiter({ limit: 60, windowMs: 60_000, blockMs: 60_000 }, now)
    const previous = connections.get(key)
    if (previous && previous !== socket) previous.close(4001, 'Reconnected')
    connections.set(key, socket)

    const { room, peerOnline } = roomService.markConnected(context.roomId, context.deviceToken)
    send(socket, {
      type: 'session.ready',
      deviceId: context.deviceId,
      role: context.role,
      roomStatus: room.status,
      peerOnline,
      verificationStatus: room.verificationStatus,
      keyExchanges: Array.from(room.keyExchanges.values()).filter((event) => event.senderRole !== context.role),
      messages: room.messages.map(({ id, senderRole, envelope, createdAt }) => ({
        id,
        senderRole,
        envelope,
        createdAt,
      })),
    })
    broadcast(context.roomId, { type: 'peer.online' }, context.deviceId)
    if (room.status === 'paired') broadcast(context.roomId, { type: 'room.paired' })

    socket.on('message', (raw) => {
      const rateLimit = messageLimiter.consume(key)
      if (!rateLimit.allowed) {
        return send(socket, errorEvent({
          code: 'RATE_LIMITED',
          message: '消息发送过于频繁',
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        }))
      }
      let decoded: unknown
      try {
        decoded = JSON.parse(raw.toString())
      } catch {
        return send(socket, errorEvent({ code: 'MESSAGE_INVALID', message: '消息格式无效' }))
      }
      const message = parseClientMessage(decoded)
      if (!('type' in message)) return send(socket, errorEvent(message))

      try {
        if (message.type === 'ping') return send(socket, { type: 'pong' })
        if (message.type === 'session.close') {
          broadcast(context.roomId, { type: 'session.closed' })
          roomService.closeRoom(context.roomId, context.deviceToken)
          return
        }
        if (message.type === 'key.exchange') {
          const event = roomService.exchangeKey(
            context.roomId,
            context.deviceToken,
            message.publicKey,
            message.proof,
          )
          sendToPeer(context.roomId, context.deviceId, event)
          return
        }
        if (message.type === 'verification.confirm') {
          const status = roomService.confirmVerification(context.roomId, context.deviceToken, message.matched)
          broadcast(context.roomId, { type: 'verification.status', status })
          if (status === 'failed') {
            broadcast(context.roomId, { type: 'session.closed' })
            roomService.closeRoom(context.roomId, context.deviceToken)
          }
          return
        }
        if (message.type === 'webrtc.offer' || message.type === 'webrtc.restart') {
          roomService.startNegotiation(context.roomId, context.deviceToken, message.negotiationId)
          sendToPeer(context.roomId, context.deviceId, { ...message, senderRole: 'creator' })
          return
        }
        if (message.type === 'webrtc.answer') {
          roomService.acceptAnswer(context.roomId, context.deviceToken, message.negotiationId)
          sendToPeer(context.roomId, context.deviceId, { ...message, senderRole: 'joiner' })
          return
        }
        if (message.type === 'webrtc.ice') {
          roomService.consumeIceCandidate(context.roomId, context.deviceToken, message.negotiationId)
          sendToPeer(context.roomId, context.deviceId, { ...message, senderRole: context.role })
          return
        }
        if (message.type === 'transfer.fallback') {
          const result = roomService.addEncryptedMessage(
            context.roomId,
            context.deviceToken,
            message.envelope,
          )
          send(socket, { type: 'message.ack', messageId: message.envelope.messageId })
          if (!result.duplicate) {
            const event: MessageDeliverEvent = { type: 'message.deliver', message: result.message }
            sendToPeer(context.roomId, context.deviceId, event)
          }
          return
        }
        if (message.type === 'image.fallback') {
          const image = roomService.getOwnEncryptedImage(
            context.roomId,
            context.deviceToken,
            message.transferId,
            message.imageId,
          )
          sendToPeer(context.roomId, context.deviceId, {
            type: 'image.deliver',
            transferId: image.transferId,
            imageId: image.imageId,
            senderRole: context.role,
            createdAt: image.createdAt,
          })
          return
        }
        if (message.type === 'message.retry') {
          const existing = roomService.getMessage(
            context.roomId,
            context.deviceToken,
            message.messageId,
          )
          send(socket, { type: 'message.ack', messageId: message.messageId })
          sendToPeer(context.roomId, context.deviceId, { type: 'message.deliver', message: existing })
          return
        }
        send(socket, errorEvent({ code: 'MESSAGE_INVALID', message: '消息类型尚未支持' }))
      } catch (error) {
        const apiError = error instanceof RoomError
          ? { code: error.code, message: error.message }
          : { code: 'INTERNAL_ERROR', message: '服务暂时不可用' }
        send(socket, errorEvent(apiError))
      }
    })

    socket.on('close', () => {
      if (connections.get(key) !== socket) return
      connections.delete(key)
      try {
        roomService.markDisconnected(context.roomId, context.deviceToken)
        broadcast(context.roomId, { type: 'peer.offline' }, context.deviceId)
      } catch {
        // The room may already have been closed by either device.
      }
    })
  }

  server.on('connection', (socket: WebSocket) => {
    let authenticated = false
    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(4401, 'Auth timeout')
    }, 10_000)

    socket.once('message', (raw) => {
      let decoded: unknown
      try {
        decoded = JSON.parse(raw.toString())
      } catch {
        return socket.close(4401, 'Unauthorized')
      }
      const auth = parseSessionAuthMessage(decoded)
      if (!('type' in auth)) return socket.close(4401, 'Unauthorized')
      try {
        const { device } = roomService.authorize(auth.roomId, auth.deviceToken)
        authenticated = true
        clearTimeout(authTimer)
        initializeConnection(socket, {
          roomId: auth.roomId,
          deviceToken: auth.deviceToken,
          deviceId: device.id,
          role: device.role,
        })
      } catch {
        socket.close(4401, 'Unauthorized')
      }
    })

    socket.on('close', () => {
      clearTimeout(authTimer)
    })
  })

  app.addHook('onClose', async () => {
    for (const socket of connections.values()) socket.close(1001, 'Server shutdown')
    server.close()
  })
}
