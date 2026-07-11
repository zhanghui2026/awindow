import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyRequest } from 'fastify'

import { validateImageUpload, type JoinRoomRequest, type SupportedImageType } from '../../shared/protocol.js'
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
  fileName?: string
  mimeType?: string
  bytes?: string
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
): Promise<void> {
  app.post('/api/rooms', async (_request, reply) => {
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

  app.delete<{ Params: RoomParams }>('/api/rooms/:roomId', async (request, reply) => {
    roomService.closeRoom(request.params.roomId, readDeviceToken(request))
    return reply.code(204).send()
  })

  app.post<{ Params: RoomParams; Body: ImageUploadBody }>('/api/rooms/:roomId/images', async (request, reply) => {
    const deviceToken = readDeviceToken(request)
    roomService.authorize(request.params.roomId, deviceToken)
    const bytes = typeof request.body?.bytes === 'string'
      ? Buffer.from(request.body.bytes, 'base64')
      : Buffer.alloc(0)
    const validationError = validateImageUpload(request.body?.mimeType, bytes.length)
    if (validationError) {
      const statusCode = validationError.code === 'IMAGE_TOO_LARGE' ? 413 : 415
      throw new RoomError(validationError.code, validationError.message, statusCode)
    }
    const image = {
      imageId: randomUUID(),
      fileName: request.body?.fileName?.trim() || 'image',
      mimeType: request.body.mimeType as SupportedImageType,
      size: bytes.length,
    }
    roomService.addImage(request.params.roomId, deviceToken, image, bytes)
    return reply.code(201).send(image)
  })

  app.get<{ Params: ImageParams }>('/api/rooms/:roomId/images/:imageId', async (request, reply) => {
    const image = roomService.getImage(
      request.params.roomId,
      readDeviceToken(request),
      request.params.imageId,
    )
    const fileName = image.metadata.fileName.replace(/["\r\n]/g, '')
    return reply
      .type(image.metadata.mimeType)
      .header('Content-Disposition', `inline; filename="${fileName}"`)
      .send(image.bytes)
  })
}
