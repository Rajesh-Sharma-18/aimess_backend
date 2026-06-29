/**
 * Moderation-mute enforcement on community-chat DELETE operations.
 *
 * deleteForMe   — any active member can hide; mute gate always applies.
 * deleteForAll  — own message: mute gate applies; mod deleting others = moderation,
 *                 not blocked by mute (the product allows muted mods to moderate).
 */
import { ForbiddenError } from "@aimess/errors";

import { CommunityMessageService } from "../../src/services/community-message.service.js";

const ROOM_ID = "c".repeat(24);
const MSG_ID = "m".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function buildService(opts: {
  isMuted: boolean;
  mutedUntil: Date | null;
  role?: string;
  messageSentBy?: string;
}) {
  const {
    isMuted,
    mutedUntil,
    role = "member",
    messageSentBy = USER_ID,
  } = opts;

  const fakeMessage = {
    id: MSG_ID,
    roomId: ROOM_ID,
    sentBy: messageSentBy,
    messageType: "TEXT",
    deletedFor: [],
  };

  const messageRepo = {
    findById: jest.fn().mockResolvedValue(fakeMessage),
    deleteForUser: jest.fn().mockResolvedValue(undefined),
    deleteForAll: jest.fn().mockResolvedValue(fakeMessage),
  };

  const roomRepo = {
    findRoomById: jest
      .fn()
      .mockResolvedValue({ id: ROOM_ID, status: "active" }),
  };

  const memberRepo = {
    findByRoomAndUser: jest.fn().mockResolvedValue({
      roomId: ROOM_ID,
      userId: USER_ID,
      status: "active",
      role,
      isMuted,
      mutedUntil,
    }),
  };

  const cacheRepo = {
    getMessageIdempotency: jest.fn(),
    setMessageIdempotency: jest.fn(),
  };

  const userSnapshotService = { resolve: jest.fn() };

  const service = new CommunityMessageService(
    messageRepo as never,
    roomRepo as never,
    memberRepo as never,
    cacheRepo as never,
    userSnapshotService as never
  );

  return { service, messageRepo };
}

describe("CommunityMessageService.deleteForMe mute guard", () => {
  it("rejects an indefinitely-muted member", async () => {
    const { service, messageRepo } = buildService({
      isMuted: true,
      mutedUntil: null,
    });
    await expect(service.deleteForMe(MSG_ID, USER_ID)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(messageRepo.deleteForUser).not.toHaveBeenCalled();
  });

  it("rejects a member under an active timed mute", async () => {
    const { service, messageRepo } = buildService({
      isMuted: true,
      mutedUntil: new Date(Date.now() + 60 * 60 * 1000),
    });
    await expect(service.deleteForMe(MSG_ID, USER_ID)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(messageRepo.deleteForUser).not.toHaveBeenCalled();
  });

  it("lets a member past once a timed mute has expired (lazy local expiry)", async () => {
    const { service, messageRepo } = buildService({
      isMuted: true,
      mutedUntil: new Date(Date.now() - 1000),
    });
    await service.deleteForMe(MSG_ID, USER_ID).catch(() => undefined);
    // Gate did not reject — persist was attempted
    expect(messageRepo.deleteForUser).toHaveBeenCalledWith(MSG_ID, USER_ID);
  });

  it("lets a non-muted active member past the mute gate", async () => {
    const { service, messageRepo } = buildService({
      isMuted: false,
      mutedUntil: null,
    });
    await service.deleteForMe(MSG_ID, USER_ID).catch(() => undefined);
    expect(messageRepo.deleteForUser).toHaveBeenCalledWith(MSG_ID, USER_ID);
  });
});

describe("CommunityMessageService.deleteForAll mute guard", () => {
  it("rejects a muted member deleting their own message", async () => {
    const { service, messageRepo } = buildService({
      isMuted: true,
      mutedUntil: null,
      messageSentBy: USER_ID, // own message
    });
    await expect(service.deleteForAll(MSG_ID, USER_ID)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(messageRepo.deleteForAll).not.toHaveBeenCalled();
  });

  it("lets a muted moderator delete another member's message (moderation action)", async () => {
    const { service, messageRepo } = buildService({
      isMuted: true,
      mutedUntil: null,
      role: "moderator",
      messageSentBy: OTHER_ID, // someone else's message
    });
    await service.deleteForAll(MSG_ID, USER_ID).catch(() => undefined);
    // Mute gate skipped because this is a moderation action on another user's content
    expect(messageRepo.deleteForAll).toHaveBeenCalledWith(MSG_ID);
  });

  it("lets a non-muted member delete their own message", async () => {
    const { service, messageRepo } = buildService({
      isMuted: false,
      mutedUntil: null,
      messageSentBy: USER_ID,
    });
    await service.deleteForAll(MSG_ID, USER_ID).catch(() => undefined);
    expect(messageRepo.deleteForAll).toHaveBeenCalledWith(MSG_ID);
  });
});
