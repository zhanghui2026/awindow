import type { Room } from './types.js'

export class RoomRepository {
  private readonly rooms = new Map<string, Room>()

  save(room: Room): void {
    this.rooms.set(room.id, room)
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId)
  }

  delete(roomId: string): boolean {
    return this.rooms.delete(roomId)
  }

  values(): IterableIterator<Room> {
    return this.rooms.values()
  }

  get size(): number {
    return this.rooms.size
  }
}
