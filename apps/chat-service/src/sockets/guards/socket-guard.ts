import type { Socket } from "socket.io";

import { BadRequestError, UnauthorizedError } from "@aimess/errors";

/**
 * Socket guard utilities for authorization checks in socket handlers.
 */
export class SocketGuard {
  /** Require that the socket has an authenticated user (not null). */
  static requireAuth(socket: Socket): void {
    if (!socket.user) {
      throw new UnauthorizedError("AUTH_UNAUTHORIZED");
    }
  }

  /** Require that the socket user is a fully authenticated (logged-in) user. */
  static requireLoggedIn(socket: Socket): void {
    if (!socket.user?.userId) {
      throw new UnauthorizedError("Authentication required");
    }
  }

  /** Assert the user is an active member of a community room (not banned). */
  static async requireValidRoomMember(
    userId: string,
    roomId: string,
    roomRepo: {
      isRoomMember: (roomId: string, userId: string) => Promise<boolean>;
    },
    memberRepo: {
      isBanned: (roomId: string, userId: string) => Promise<boolean>;
    }
  ): Promise<{ isMember: boolean }> {
    const isBanned = await memberRepo.isBanned(roomId, userId);
    if (isBanned) {
      const error = new BadRequestError("CHAT_BANNED_FROM_ROOM");
      (error as unknown as Record<string, string>).code = "BANNED";
      throw error;
    }
    const isMember = await roomRepo.isRoomMember(roomId, userId);
    return { isMember };
  }
}
