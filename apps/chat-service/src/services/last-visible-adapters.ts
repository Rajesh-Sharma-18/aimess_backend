/**
 * VisibilitySource factories — the single place that normalizes each surface's
 * message + deletion shape into the room-type-agnostic contract the shared
 * LastVisibleResolver consumes. Type-only imports of the repositories keep this
 * free of runtime DI coupling; every list builder and delete path constructs its
 * source through one of these so the three deletion shapes are normalized ONCE.
 */
import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { VisibilitySource } from "./last-visible-resolver.js";

/** Community: `deletedForAll: boolean` + `deletedBy: string[]` (ARRAY). */
export function communityVisibilitySource(
  repo: GeneralRoomMessageRepository
): VisibilitySource {
  return {
    filterHidden: (ids, userId) => repo.filterHiddenByUser(ids, userId),
    findPreviousVisibleForUser: async (roomId, userId) => {
      const m = await repo.findPreviousVisibleForUser(roomId, userId);
      return m
        ? {
            messageId: m.id,
            senderId: m.sentBy,
            senderName: m.senderName ?? "",
            messageType: m.messageType,
            content: m.message ?? "",
            createdAt: m.createdAt,
          }
        : null;
    },
    hidersAmong: async (messageId, userIds) => {
      const m = await repo.findById(messageId);
      if (!m) return new Set();
      const deletedBy = (m.deletedBy ?? []) as unknown as string[];
      const hid = new Set(deletedBy);
      return new Set(userIds.filter((u) => hid.has(u)));
    },
  };
}

/** Private: `isDeleted: boolean` + `deletedFor: { [userId]: ts }` (MAP). */
export function privateVisibilitySource(
  repo: PrivateMessageRepository
): VisibilitySource {
  return {
    filterHidden: (ids, userId) => repo.filterHiddenFromUser(ids, userId),
    findPreviousVisibleForUser: async (roomId, userId) => {
      const m = await repo.findPreviousVisibleForUser(roomId, userId);
      return m
        ? {
            messageId: m.id,
            senderId: m.senderId ?? "",
            // PrivateMessage carries no senderName — the list resolves the peer
            // label itself from the room participants.
            senderName: "",
            messageType: m.messageType,
            content: m.content,
            createdAt: m.createdAt,
          }
        : null;
    },
    hidersAmong: async (messageId, userIds) => {
      const m = await repo.findById(messageId);
      if (!m) return new Set();
      const map = (m.deletedFor ?? {}) as Record<string, unknown>;
      return new Set(userIds.filter((u) => u in map));
    },
  };
}

/** Group: `isDeleted: boolean` + `deletedForUserIds: string[]` (ARRAY). */
export function groupVisibilitySource(
  repo: GroupMessageRepository
): VisibilitySource {
  return {
    filterHidden: (ids, userId) => repo.filterHiddenFromUser(ids, userId),
    findPreviousVisibleForUser: async (roomId, userId) => {
      const m = await repo.findPreviousVisibleForUser(roomId, userId);
      return m
        ? {
            messageId: m.id,
            senderId: m.senderId ?? "",
            senderName: m.senderName ?? "",
            messageType: m.messageType,
            content: m.content,
            createdAt: m.createdAt,
          }
        : null;
    },
    hidersAmong: async (messageId, userIds) => {
      const m = await repo.findById(messageId);
      if (!m) return new Set();
      const arr = (m.deletedForUserIds ?? []) as unknown as string[];
      const hid = new Set(arr);
      return new Set(userIds.filter((u) => hid.has(u)));
    },
  };
}
