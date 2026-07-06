/**
 * `CommunityPinService.getActivePinSummary` — the FE-header-ready `pinnedMessage`
 * field embedded on the Community Messages API (REST `GET /rooms/:roomId/messages`
 * and the gRPC/socket `community:messages:fetch` equivalent).
 *
 * Reuses the existing `CommunityMessagePin` persistence (pin/unpin) — no
 * separate pin store, no new API. Query cost is fixed regardless of page
 * size: 1 query to find the active pin, and — only if one exists — 1 query
 * for the live message row plus one batched user-snapshot lookup.
 */
import { CommunityPinService } from "../../src/services/community-pin.service.js";

const ROOM_ID = "c".repeat(24);
const MSG_ID = "m".repeat(24);
const MSG_ID_2 = "n".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";

function makeService(overrides: {
  findActivePinByRoom: jest.Mock;
  findById?: jest.Mock;
  getUserSnapshotsMap?: jest.Mock;
}) {
  const pinRepo = {
    findActivePinByRoom: overrides.findActivePinByRoom,
  } as never;
  const messageRepo = {
    findById: overrides.findById ?? jest.fn().mockResolvedValue(null),
  } as never;
  const roomRepo = {} as never;
  const memberRepo = {} as never;
  const systemMessageService = undefined;
  const userSnapshotService = overrides.getUserSnapshotsMap
    ? ({ getUserSnapshotsMap: overrides.getUserSnapshotsMap } as never)
    : undefined;
  const cacheRepo = overrides.getUserSnapshotsMap ? ({} as never) : undefined;

  return new CommunityPinService(
    pinRepo,
    messageRepo,
    roomRepo,
    memberRepo,
    systemMessageService,
    userSnapshotService,
    cacheRepo
  );
}

describe("getActivePinSummary — no pinned message", () => {
  it("returns null when the room has no active pin", async () => {
    const svc = makeService({
      findActivePinByRoom: jest.fn().mockResolvedValue(null),
    });
    const result = await svc.getActivePinSummary(ROOM_ID);
    expect(result).toBeNull();
  });

  it("does not query the message repo at all when there is no active pin (fixed query cost)", async () => {
    const findById = jest.fn();
    const svc = makeService({
      findActivePinByRoom: jest.fn().mockResolvedValue(null),
      findById,
    });
    await svc.getActivePinSummary(ROOM_ID);
    expect(findById).not.toHaveBeenCalled();
  });
});

describe("getActivePinSummary — pinned message", () => {
  it("returns the FE-header-ready summary sourced from the LIVE message row", async () => {
    const pinnedAt = new Date("2026-07-01T10:00:00.000Z");
    const messageCreatedAt = new Date("2026-06-30T09:00:00.000Z");
    const liveCreatedAt = new Date("2026-06-30T09:00:00.000Z");

    const findActivePinByRoom = jest.fn().mockResolvedValue({
      messageId: MSG_ID,
      roomId: ROOM_ID,
      communityId: ROOM_ID,
      pinnedBy: MOD_ID,
      pinnedAt,
      unpinnedAt: null,
      originalMessageDeletedAt: null,
      messageCreatedAt,
      senderId: USER_ID,
      senderDisplayName: "Stale Snapshot Name",
      senderAvatar: "",
      contentPinned: { text: "stale snapshot text", urls: [], files: [] },
    });
    const findById = jest.fn().mockResolvedValue({
      id: MSG_ID,
      roomId: ROOM_ID,
      sentBy: USER_ID,
      senderName: "Live Sender Name",
      senderAvatar: "",
      message: "Meeting at 3pm tomorrow",
      messageType: "TEXT",
      attachments: [],
      deletedForAll: false,
      createdAt: liveCreatedAt,
    });
    const getUserSnapshotsMap = jest
      .fn()
      .mockResolvedValue(new Map([[USER_ID, { memberId: "alice_handle" }]]));

    const svc = makeService({
      findActivePinByRoom,
      findById,
      getUserSnapshotsMap,
    });
    const result = await svc.getActivePinSummary(ROOM_ID);

    expect(result).toEqual({
      messageId: MSG_ID,
      roomId: ROOM_ID,
      communityId: ROOM_ID,
      senderId: USER_ID,
      senderName: "Live Sender Name",
      senderHandle: "alice_handle",
      senderAvatar: "",
      messageType: "TEXT",
      text: "Meeting at 3pm tomorrow",
      media: [],
      createdAt: liveCreatedAt.getTime(),
      pinnedAt: pinnedAt.getTime(),
      pinnedBy: MOD_ID,
      isAvailable: true,
    });
  });

  it("only ever issues 2 repo queries + 1 snapshot lookup, independent of the room's message count (no N+1)", async () => {
    const findActivePinByRoom = jest.fn().mockResolvedValue({
      messageId: MSG_ID,
      roomId: ROOM_ID,
      communityId: ROOM_ID,
      pinnedBy: MOD_ID,
      pinnedAt: new Date(),
      unpinnedAt: null,
      originalMessageDeletedAt: null,
      messageCreatedAt: new Date(),
      senderId: USER_ID,
      senderDisplayName: "",
      senderAvatar: "",
      contentPinned: { text: "", urls: [], files: [] },
    });
    const findById = jest.fn().mockResolvedValue({
      id: MSG_ID,
      roomId: ROOM_ID,
      sentBy: USER_ID,
      senderName: "",
      senderAvatar: "",
      message: "hi",
      messageType: "TEXT",
      attachments: [],
      deletedForAll: false,
      createdAt: new Date(),
    });
    const getUserSnapshotsMap = jest.fn().mockResolvedValue(new Map());

    const svc = makeService({
      findActivePinByRoom,
      findById,
      getUserSnapshotsMap,
    });
    await svc.getActivePinSummary(ROOM_ID);

    expect(findActivePinByRoom).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledTimes(1);
    expect(getUserSnapshotsMap).toHaveBeenCalledTimes(1);
  });

  it("falls back to the pin's frozen snapshot and isAvailable:false when the original message was hard-deleted", async () => {
    const findActivePinByRoom = jest.fn().mockResolvedValue({
      messageId: MSG_ID,
      roomId: ROOM_ID,
      communityId: ROOM_ID,
      pinnedBy: MOD_ID,
      pinnedAt: new Date("2026-07-01T10:00:00.000Z"),
      unpinnedAt: null,
      originalMessageDeletedAt: new Date("2026-07-02T10:00:00.000Z"),
      messageCreatedAt: new Date("2026-06-30T09:00:00.000Z"),
      senderId: USER_ID,
      senderDisplayName: "Frozen Name",
      senderAvatar: "",
      contentPinned: { text: "frozen snapshot text", urls: [], files: [] },
    });
    const findById = jest.fn().mockResolvedValue({
      id: MSG_ID,
      roomId: ROOM_ID,
      sentBy: USER_ID,
      deletedForAll: true,
      createdAt: new Date(),
    });

    const svc = makeService({ findActivePinByRoom, findById });
    const result = await svc.getActivePinSummary(ROOM_ID);

    expect(result).toMatchObject({
      messageId: MSG_ID,
      senderName: "Frozen Name",
      text: "frozen snapshot text",
      media: [],
      isAvailable: false,
    });
  });
});

describe("getActivePinSummary — replace pinned message", () => {
  it("reflects the NEW pin immediately after a moderator pins a different message", async () => {
    const findActivePinByRoom = jest.fn();
    const findById = jest.fn();

    // First call: message #1 is pinned.
    findActivePinByRoom.mockResolvedValueOnce({
      messageId: MSG_ID,
      roomId: ROOM_ID,
      communityId: ROOM_ID,
      pinnedBy: MOD_ID,
      pinnedAt: new Date("2026-07-01T10:00:00.000Z"),
      unpinnedAt: null,
      originalMessageDeletedAt: null,
      messageCreatedAt: new Date(),
      senderId: USER_ID,
      senderDisplayName: "",
      senderAvatar: "",
      contentPinned: { text: "", urls: [], files: [] },
    });
    findById.mockResolvedValueOnce({
      id: MSG_ID,
      roomId: ROOM_ID,
      sentBy: USER_ID,
      message: "first pinned message",
      messageType: "TEXT",
      attachments: [],
      deletedForAll: false,
      createdAt: new Date(),
    });

    const svc = makeService({ findActivePinByRoom, findById });
    const first = await svc.getActivePinSummary(ROOM_ID);
    expect(first?.messageId).toBe(MSG_ID);
    expect(first?.text).toBe("first pinned message");

    // Second call (after unpin #1 + pin #2): the active pin is now message #2.
    findActivePinByRoom.mockResolvedValueOnce({
      messageId: MSG_ID_2,
      roomId: ROOM_ID,
      communityId: ROOM_ID,
      pinnedBy: MOD_ID,
      pinnedAt: new Date("2026-07-01T11:00:00.000Z"),
      unpinnedAt: null,
      originalMessageDeletedAt: null,
      messageCreatedAt: new Date(),
      senderId: USER_ID,
      senderDisplayName: "",
      senderAvatar: "",
      contentPinned: { text: "", urls: [], files: [] },
    });
    findById.mockResolvedValueOnce({
      id: MSG_ID_2,
      roomId: ROOM_ID,
      sentBy: USER_ID,
      message: "second pinned message",
      messageType: "TEXT",
      attachments: [],
      deletedForAll: false,
      createdAt: new Date(),
    });

    const second = await svc.getActivePinSummary(ROOM_ID);
    expect(second?.messageId).toBe(MSG_ID_2);
    expect(second?.text).toBe("second pinned message");
  });
});

describe("getActivePinSummary — unpin message", () => {
  it("returns null immediately after the active pin is soft-deleted", async () => {
    // Simulates the state right after CommunityPinService.unpin() ran:
    // findActivePinByRoom's own query (`unpinnedAt: null`) now returns nothing.
    const findActivePinByRoom = jest.fn().mockResolvedValue(null);
    const svc = makeService({ findActivePinByRoom });

    const result = await svc.getActivePinSummary(ROOM_ID);
    expect(result).toBeNull();
  });
});
