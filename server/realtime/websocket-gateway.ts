import type { IncomingMessage } from 'node:http'

import type { FastifyInstance } from 'fastify'
import { WebSocket, WebSocketServer } from 'ws'

import {
  parseClientMessage,
  type ApiError,
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
  const server = new WebSocketServer({ noServer: true })
  const connections = new Map<string, WebSocket>()
  const contexts = new WeakMap<WebSocket, ConnectionContext>()

  const connectionKey = (roomId: string, deviceId: string) => `${roomId}:${deviceId}`
  const broadcast = (roomId: string, message: ServerMessage, exceptDeviceId?: string) => {
    for (const [key, socket] of connections) {
      if (key.startsWith(`${roomId}:`) && key !== connectionKey(roomId, exceptDeviceId ?? '')) {
        send(socket, message)
      }
    }
  }

  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') return

    const roomId = url.searchParams.get('roomId') ?? ''
    const deviceToken = url.searchParams.get('deviceToken') ?? ''
    try {
      const { device } = roomService.authorize(roomId, deviceToken)
      server.handleUpgrade(request, socket, head, (webSocket) => {
        contexts.set(webSocket, { roomId, deviceToken, deviceId: device.id })
        server.emit('connection', webSocket, request)
      })
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  })

  server.on('connection', (socket: WebSocket, _request: IncomingMessage) => {
    const context = contexts.get(socket)
    if (!context) return socket.close(1011, 'Missing context')

    const key = connectionKey(context.roomId, context.deviceId)
    const messageLimiter = new RateLimiter({ limit: 60, windowMs: 60_000, blockMs: 60_000 }, now)
    const previous = connections.get(key)
    if (previous && previous !== socket) previous.close(4001, 'Reconnected')
    connections.set(key, socket)

    const { room, peerOnline } = roomService.markConnected(context.roomId, context.deviceToken)
    send(socket, {
      type: 'session.ready',
      deviceId: context.deviceId,
      roomStatus: room.status,
      peerOnline,
      messages: room.messages,
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
        if (message.type === 'text.send') {
          const result = roomService.addTextMessage(
            context.roomId,
            context.deviceToken,
            message.clientMessageId,
            message.text,
          )
          send(socket, { type: 'message.ack', clientMessageId: message.clientMessageId })
          if (!result.duplicate) {
            const event: MessageDeliverEvent = { type: 'message.deliver', message: result.message }
            broadcast(context.roomId, event, context.deviceId)
          }
          return
        }
        if (message.type === 'image.send') {
          const result = roomService.addImageMessage(
            context.roomId,
            context.deviceToken,
            message.clientMessageId,
            message.image,
          )
          send(socket, { type: 'message.ack', clientMessageId: message.clientMessageId })
          if (!result.duplicate) {
            broadcast(
              context.roomId,
              { type: 'message.deliver', message: result.message },
              context.deviceId,
            )
          }
          return
        }
        if (message.type === 'message.retry') {
          const existing = roomService.getMessage(
            context.roomId,
            context.deviceToken,
            message.clientMessageId,
          )
          send(socket, { type: 'message.ack', clientMessageId: message.clientMessageId })
          broadcast(context.roomId, { type: 'message.deliver', message: existing }, context.deviceId)
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
  })

  app.addHook('onClose', async () => {
    for (const socket of connections.values()) socket.close(1001, 'Server shutdown')
    server.close()
  })
}
