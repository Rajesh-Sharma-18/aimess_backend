/**
 * `GroupMessageService.listMediaForModeration` — the Super Admin media viewer's
 * room-wide gallery walk. Same query as the member Media tab, but the admin is
 * never a member, so it must neither check membership nor narrow by a per-user
 * cutoff, and it pages with an exact hasMore + createdAt cursor.
 */
import { GroupMessageService } from "../../src/services/group-message.service.js";

jest.mock("../../src/lib/media-resolve.js", () => {
  const actual = jest.requireActual("../../src/lib/media-resolve.js");
  return {
    ...actual,
    resolveMediaUrl: jest.fn(async (key?: string | null) =>
      key ? `https://cdn.test/${key}` : ""
    ),
    resolveMediaUrls: jest.fn(async (keys: string[]) =>
      Object.fromEntries((keys ?? []).map((k) => [k, `https://cdn.test/${k}`]))
    ),
    resolveContentFiles: jest.fn(async (files: unknown[]) => files ?? []),
  };
});

const ROOM_ID = "grp_media_gallery";

function mkRow(n: number) {
  return {
    id: `m${n}`,
    _id: `m${n}`,
    roomId: ROOM_ID,
    senderId: "u1",
    senderName: "Ann",
    senderAvatar: "",
    content: { text: "", files: [{ objectKey: `k${n}`, mime: "image/jpeg" }] },
    contentType: "IMAGE",
    messageType: "IMAGE",
    reactions: null,
    sequenceNumber: n,
    serverTs: 1_700_000_000_000 + n,
    createdAt: new Date(1_700_000_000_000 + n),
    isDeleted: false,
    deletedForUserIds: [],
  };
}

function makeService(listMedia: jest.Mock, findActiveByRoomAndUser = jest.fn()) {
  return new GroupMessageService(
    { listMedia } as never,
    { findActiveByRoomAndUser } as never,
    {} as never,
    {} as never,
    { getUserSnapshotsMap: jest.fn().mockResolvedValue(new Map()) } as never
  );
}

describe("GroupMessageService.listMediaForModeration", () => {
  it("asks for IMAGE/VIDEO with no viewer and no membership check", async () => {
    const listMedia = jest.fn().mockResolvedValue([mkRow(3), mkRow(2)]);
    const membership = jest.fn();
    const page = await makeService(listMedia, membership).listMediaForModeration({
      roomId: ROOM_ID,
      limit: 5,
    });

    expect(membership).not.toHaveBeenCalled();
    expect(listMedia).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      userId: "",
      type: "media",
      cursor: null,
      limit: 6,
    });
    expect(page.items.map((m) => m.id)).toEqual(["m3", "m2"]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("reports hasMore from the extra row and hands back the last createdAt", async () => {
    const listMedia = jest.fn().mockResolvedValue([mkRow(5), mkRow(4), mkRow(3)]);
    const page = await makeService(listMedia).listMediaForModeration({
      roomId: ROOM_ID,
      cursor: "2024-01-01T00:00:00.000Z",
      limit: 2,
    });

    expect(listMedia.mock.calls[0][0].cursor).toBe("2024-01-01T00:00:00.000Z");
    expect(page.items.map((m) => m.id)).toEqual(["m5", "m4"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(new Date(1_700_000_000_004).toISOString());
  });
});
