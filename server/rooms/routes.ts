import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  MAX_ENCRYPTED_IMAGE_BYTES,
  type JoinRoomRequest,
  type WebRtcConfigResponse,
} from '../../shared/protocol.js'
import { RoomError } from './errors.js'
import type { RoomService } from './room-service.js'
import type { RateLimiter } from '../security/rate-limiter.js'

interface RoomParams {
  roomId: string
}

interface ImageParams extends RoomParams {
  imageId: string
}

interface ImageUploadBody {
  transferId?: string
  bytes?: string
}

interface WebRtcConfigQuery {
  roomId: string
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new RoomError('ENCRYPTED_PAYLOAD_INVALID', '加密图片载荷无效', 400)
  }
  return Buffer.from(value, 'base64')
}

function readDeviceToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) {
    throw new RoomError('SESSION_UNAUTHORIZED', '会话凭据无效', 401)
  }
  return authorization.slice('Bearer '.length)
}

export async function registerRoomRoutes(
  app: FastifyInstance,
  roomService: RoomService,
  invalidPairingLimiter: RateLimiter,
  roomCreationLimiter: RateLimiter,
  webRtcConfig: WebRtcConfigResponse,
): Promise<void> {
  app.post('/api/rooms', async (request, reply) => {
    const rateLimit = roomCreationLimiter.consume(request.ip)
    if (!rateLimit.allowed) {
      throw new RoomError(
        'RATE_LIMITED',
        `请求过于频繁，请在 ${rateLimit.retryAfterSeconds} 秒后重试`,
        429,
        rateLimit.retryAfterSeconds,
      )
    }
    return reply.code(201).send(roomService.createRoom())
  })

  app.post<{ Body: JoinRoomRequest }>('/api/rooms/join', async (request) => {
    const source = request.ip
    try {
      const joined = roomService.joinRoom(request.body?.pairingCode ?? '')
      invalidPairingLimiter.reset(source)
      return joined
    } catch (error) {
      if (error instanceof RoomError && ['PAIRING_CODE_INVALID', 'ROOM_EXPIRED'].includes(error.code)) {
        const result = invalidPairingLimiter.consume(source)
        if (!result.allowed) {
          throw new RoomError(
            'RATE_LIMITED',
            `请求过于频繁，请在 ${result.retryAfterSeconds} 秒后重试`,
            429,
            result.retryAfterSeconds,
          )
        }
      }
      throw error
    }
  })

  app.get<{ Querystring: WebRtcConfigQuery }>('/api/webrtc/config', async (request) => {
    roomService.authorize(request.query.roomId, readDeviceToken(request))
    return webRtcConfig
  })

  app.delete<{ Params: RoomParams }>('/api/rooms/:roomId', async (request, reply) => {
    roomService.closeRoom(request.params.roomId, readDeviceToken(request))
    return reply.code(204).send()
  })

  app.post<{ Params: RoomParams; Body: ImageUploadBody }>('/api/rooms/:roomId/images', async (request, reply) => {
    const deviceToken = readDeviceToken(request)
    roomService.authorize(request.params.roomId, deviceToken)
    const transferId = request.body?.transferId
    if (typeof transferId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(transferId)) {
      throw new RoomError('ENCRYPTED_PAYLOAD_INVALID', '图片传输标识无效', 400)
    }
    const bytes = decodeBase64(request.body?.bytes)
    if (bytes.length > MAX_ENCRYPTED_IMAGE_BYTES) throw new RoomError('IMAGE_TOO_LARGE', '加密图片载荷超过上限', 413)
    const result = roomService.addEncryptedImage(
      request.params.roomId,
      deviceToken,
      transferId,
      randomUUID(),
      bytes,
    )
    return reply.code(result.duplicate ? 200 : 201).send({
      imageId: result.image.imageId,
      transferId: result.image.transferId,
      size: result.image.bytes.length,
      duplicate: result.duplicate,
    })
  })

  app.get<{ Params: ImageParams }>('/api/rooms/:roomId/images/:imageId', async (request, reply) => {
    const bytes = roomService.getEncryptedImage(
      request.params.roomId,
      readDeviceToken(request),
      request.params.imageId,
    )
    return reply
      .type('application/octet-stream')
      .send(bytes)
  })
}
