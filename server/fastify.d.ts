import type { RoomService } from './rooms/room-service.js'

declare module 'fastify' {
  interface FastifyInstance {
    roomService: RoomService
  }
}
