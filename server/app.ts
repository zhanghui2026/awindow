import Fastify, { type FastifyInstance } from 'fastify'

import { MAX_ENCRYPTED_IMAGE_BYTES, type ApiError } from '../shared/protocol.js'
import { RoomError } from './rooms/errors.js'
import { RoomRepository } from './rooms/room-repository.js'
import { registerRoomRoutes } from './rooms/routes.js'
import { RoomService, type RoomServiceOptions } from './rooms/room-service.js'
import { registerWebSocketGateway } from './realtime/websocket-gateway.js'
import { RateLimiter } from './security/rate-limiter.js'
import type { WebRtcConfigResponse } from '../shared/protocol.js'

export interface AppOptions extends RoomServiceOptions {
  cleanupIntervalMs?: number
  logger?: boolean
  now?: () => number
  trustProxy?: boolean
  webRtcConfig?: WebRtcConfigResponse
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: Math.ceil(MAX_ENCRYPTED_IMAGE_BYTES * 4 / 3) + 1024 * 1024,
    trustProxy: options.trustProxy ?? false,
  })
  const repository = new RoomRepository()
  const roomService = new RoomService(repository, options)
  const invalidPairingLimiter = new RateLimiter(
    { limit: 10, windowMs: 60_000, blockMs: 5 * 60_000 },
    options.now,
  )
  const roomCreationLimiter = new RateLimiter(
    { limit: 20, windowMs: 60_000, blockMs: 60_000 },
    options.now,
  )
  const cleanupTimer = setInterval(
    () => roomService.cleanupExpired(),
    options.cleanupIntervalMs ?? 30_000,
  )
  cleanupTimer.unref()

  app.decorate('roomService', roomService)
  app.addHook('onClose', async () => clearInterval(cleanupTimer))
  app.addHook('onSend', async (_request, reply, payload) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'no-store')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      .header('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws: wss:")
    return payload
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RoomError) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', error.retryAfterSeconds)
      }
      const body: ApiError = {
        code: error.code,
        message: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
      }
      return reply.code(error.statusCode).send(body)
    }
    app.log.error(error)
    const body: ApiError = { code: 'INTERNAL_ERROR', message: '服务暂时不可用' }
    return reply.code(500).send(body)
  })

  app.get('/health', async () => ({ status: 'ok' }))
  await registerRoomRoutes(
    app,
    roomService,
    invalidPairingLimiter,
    roomCreationLimiter,
    options.webRtcConfig ?? { iceServers: [], negotiationTimeoutMs: 10_000 },
  )
  registerWebSocketGateway(app, roomService, options.now)

  return app
}
