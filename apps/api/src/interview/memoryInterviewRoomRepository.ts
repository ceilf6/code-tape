import type { InterviewRoom, InterviewRoomRepository } from "./types.js";

export function createMemoryInterviewRoomRepository(): InterviewRoomRepository {
  const rooms = new Map<string, InterviewRoom>();

  return {
    get(roomId) {
      const room = rooms.get(roomId);
      return room ? cloneRoom(room) : null;
    },
    save(room) {
      rooms.set(room.id, cloneRoom(room));
    },
  };
}

function cloneRoom(room: InterviewRoom): InterviewRoom {
  return { ...room };
}
