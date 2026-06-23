/**
 * Community CLOSED / SUSPENDED write gate.
 *
 * `assertCommunityRoomWritable` (src/lib/access-guard.ts) is the SINGLE place
 * chat-service decides whether a community general room accepts writes. When the
 * owner closes a community (status → CLOSED) or the platform suspends it, the
 * room's `status` is moved to "suspended" and ALL mutating chat paths
 * (send / edit / delete / react / pin) must reject — the community is read-only.
 */
import { ForbiddenError } from "@aimess/errors";

import { assertCommunityRoomWritable } from "../../src/lib/access-guard.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";

describe("assertCommunityRoomWritable (the single write gate)", () => {
  it("passes for an active room", () => {
    expect(() =>
      assertCommunityRoomWritable({ status: "active" })
    ).not.toThrow();
  });

  it("throws COMMUNITY_SUSPENDED for a suspended (closed) room", () => {
    try {
      assertCommunityRoomWritable({ status: "suspended" });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).message).toBe("COMMUNITY_SUSPENDED");
    }
  });

  it("throws COMMUNITY_CHAT_DISABLED for an inactive/missing room", () => {
    for (const room of [{ status: "inactive" }, null, undefined]) {
      try {
        assertCommunityRoomWritable(room);
        throw new Error("expected to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenError);
        expect((e as ForbiddenError).message).toBe("COMMUNITY_CHAT_DISABLED");
      }
    }
  });
});

const ROOM_ID = "c".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const MSG_ID = "m".repeat(24);

/** Build the service with a room whose status we control + an ACTIVE member. */
function buildService(roomStatus: string) {
  const message = {
    id: MSG_ID,
    roomId: ROOM_ID,
    sentBy: USER_ID,
    messageType: "TEXT",
    deletedForAll: false,
    createdAt: new Date(),
  };
  const messageRepo = {
    create: jest.fn(),
    findOne: jest.fn(),
    findById: jest.fn().mockResolvedValue(message),
    editMessage: jest.fn(),
    updateById: jest.fn(),
  };
  const roomRepo = {
    findRoomById: jest
      .fn()
      .mockResolvedValue({ id: ROOM_ID, status: roomStatus }),
  };
  const memberRepo = {
    findByRoomAndUser: jest.fn().mockResolvedValue({
      roomId: ROOM_ID,
      userId: USER_ID,
      status: "active",
      role: "member",
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

describe("community write paths blocked on a CLOSED (suspended) room", () => {
  const sendParams = {
    roomId: ROOM_ID,
    sentBy: USER_ID,
    senderName: "John",
    senderAvatar: "",
    message: "hello",
    messageType: "TEXT",
  };

  it("send is rejected and never persists", async () => {
    const { service, messageRepo } = buildService("suspended");
    await expect(service.sendMessage(sendParams)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it("edit is rejected and never writes", async () => {
    const { service, messageRepo } = buildService("suspended");
    await expect(
      service.editMessage({
        messageId: MSG_ID,
        userId: USER_ID,
        content: { text: "edited" },
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(messageRepo.editMessage).not.toHaveBeenCalled();
  });

  it("react is rejected and never writes", async () => {
    const { service, messageRepo } = buildService("suspended");
    await expect(
      service.reactToMessage({
        messageId: MSG_ID,
        userId: USER_ID,
        emoji: "👍",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(messageRepo.updateById).not.toHaveBeenCalled();
  });

  it("an ACTIVE room lets edit past the write gate", async () => {
    const { service, messageRepo } = buildService("active");
    await service
      .editMessage({
        messageId: MSG_ID,
        userId: USER_ID,
        content: { text: "edited" },
      })
      .catch(() => undefined);
    // Reached the actual edit write (gate + membership both cleared).
    expect(messageRepo.editMessage).toHaveBeenCalled();
  });
});
