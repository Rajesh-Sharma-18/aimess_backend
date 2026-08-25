/**
 * Moderation mute must gate EVERY community write path, not just plain send.
 *
 * `community-send-mute-guard.test.ts` already covers `sendMessage` (the single
 * chokepoint every text/media/GIF/sticker/voice send funnels through). The other
 * ways a member can mutate room content — reacting and editing — each load their
 * own `RoomMember` row and so need their own guard; this pins them so a future
 * refactor of either path cannot silently drop it.
 *
 * Enforcement is server-side and reads the mirrored `RoomMember.isMuted` /
 * `mutedUntil`, so it holds for a caller hitting REST or gRPC directly with a
 * client that believes it is not muted.
 */
import { ForbiddenError } from "@aimess/errors";

import { CommunityMessageService } from "../../src/services/community-message.service.js";

const ROOM_ID = "c".repeat(24);
const MESSAGE_ID = "d".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";

function buildService(mute: { isMuted: boolean; mutedUntil: Date | null }) {
  const message = {
    _id: MESSAGE_ID,
    id: MESSAGE_ID,
    roomId: ROOM_ID,
    sentBy: USER_ID,
    message: "hello",
    messageType: "TEXT",
    deletedForAll: false,
    createdAt: new Date(),
    reactions: {},
  };
  const messageRepo = {
    findById: jest.fn().mockResolvedValue(message),
    update: jest.fn(),
    setReactions: jest.fn(),
    updateReactions: jest.fn(),
  };
  const roomRepo = {
    findRoomById: jest.fn().mockResolvedValue({ id: ROOM_ID, status: "active" }),
  };
  const memberRepo = {
    findByRoomAndUser: jest.fn().mockResolvedValue({
      roomId: ROOM_ID,
      userId: USER_ID,
      status: "active",
      role: "member",
      isMuted: mute.isMuted,
      mutedUntil: mute.mutedUntil,
    }),
  };
  const cacheRepo = {
    getMessageIdempotency: jest.fn(),
    setMessageIdempotency: jest.fn(),
  };
  const userSnapshotService = { resolve: jest.fn(), bulkResolve: jest.fn() };

  const service = new CommunityMessageService(
    messageRepo as never,
    roomRepo as never,
    memberRepo as never,
    cacheRepo as never,
    userSnapshotService as never
  );
  return { service, messageRepo };
}

const MUTED_INDEFINITELY = { isMuted: true, mutedUntil: null };
const MUTED_TIMED = {
  isMuted: true,
  mutedUntil: new Date(Date.now() + 60 * 60 * 1000),
};
const MUTE_EXPIRED = { isMuted: true, mutedUntil: new Date(Date.now() - 1000) };

describe("community write paths under a moderation mute", () => {
  describe("reactToMessage", () => {
    it("rejects an indefinitely-muted member and writes nothing", async () => {
      const { service, messageRepo } = buildService(MUTED_INDEFINITELY);
      await expect(
        service.reactToMessage({
          messageId: MESSAGE_ID,
          userId: USER_ID,
          emoji: "🔥",
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(messageRepo.update).not.toHaveBeenCalled();
      expect(messageRepo.updateReactions).not.toHaveBeenCalled();
    });

    it("rejects a member under a still-running timed mute", async () => {
      const { service } = buildService(MUTED_TIMED);
      await expect(
        service.reactToMessage({
          messageId: MESSAGE_ID,
          userId: USER_ID,
          emoji: "🔥",
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("lets the member past once the timed mute has lapsed (lazy expiry)", async () => {
      const { service } = buildService(MUTE_EXPIRED);
      // The minimal mocks can't complete the CAS write; we only assert the mute
      // gate itself did not reject.
      const err = await service
        .reactToMessage({ messageId: MESSAGE_ID, userId: USER_ID, emoji: "🔥" })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("editMessage", () => {
    it("rejects an indefinitely-muted member and never updates the row", async () => {
      const { service, messageRepo } = buildService(MUTED_INDEFINITELY);
      await expect(
        service.editMessage({
          messageId: MESSAGE_ID,
          userId: USER_ID,
          content: { text: "edited" },
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(messageRepo.update).not.toHaveBeenCalled();
    });

    it("rejects a member under a still-running timed mute", async () => {
      const { service } = buildService(MUTED_TIMED);
      await expect(
        service.editMessage({
          messageId: MESSAGE_ID,
          userId: USER_ID,
          content: { text: "edited" },
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("lets the member past once the timed mute has lapsed (lazy expiry)", async () => {
      const { service } = buildService(MUTE_EXPIRED);
      const err = await service
        .editMessage({
          messageId: MESSAGE_ID,
          userId: USER_ID,
          content: { text: "edited" },
        })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(ForbiddenError);
    });
  });
});
