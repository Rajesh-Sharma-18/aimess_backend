/**
 * `GroupMessageService.getMessagesForModeration` — the jump-to-message window
 * behind the Super Admin conversation viewer's pinned banner.
 *
 * A pinned message is routinely far older than the page the viewer loads, so
 * clicking the banner cannot just scroll: it asks for a window CENTRED on that
 * exact message id. Two things must hold, and both are easy to regress —
 *
 *  - the window is anchored on the anchor row's OWN sequence number, never on a
 *    timestamp neighbourhood, so the viewer lands on the pinned message itself
 *    rather than whatever happens to sit near it;
 *  - a pin whose original is gone reports `found: false` with no rows, so the
 *    viewer can say "no longer available" instead of silently leaving the
 *    transcript where it was or scrolling to the wrong row.
 *
 * `userId: ""` throughout: the admin is not a member, so no per-member
 * delete-for-me or clear-chat cutoff narrows what moderation may see.
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

const ROOM_ID = "grp_moderation_window";
const ANCHOR_ID = "a".repeat(24);

type RepoMock = {
  findById: jest.Mock;
  findAroundSeq: jest.Mock;
  findByRoomIdSeq: jest.Mock;
};

function mkRow(id: string, seq: number) {
  return {
    id,
    _id: id,
    roomId: ROOM_ID,
    senderId: "u1",
    senderName: "Ann",
    senderAvatar: "",
    content: { text: `m${seq}` },
    contentType: "TEXT",
    reactions: null,
    sequenceNumber: seq,
    serverTs: 1_700_000_000_000 + seq,
    createdAt: new Date(1_700_000_000_000 + seq),
    isDeleted: false,
    deletedForUserIds: [],
  };
}

function makeService(repo: RepoMock) {
  return new GroupMessageService(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    // Sender identities are resolved on the wire path; nothing here is deleted,
    // so an empty map leaves the stored names untouched.
    { getUserSnapshotsMap: jest.fn().mockResolvedValue(new Map()) } as never
  );
}

function makeRepo(over: Partial<RepoMock> = {}): RepoMock {
  return {
    findById: jest.fn().mockResolvedValue(null),
    findAroundSeq: jest.fn().mockResolvedValue([]),
    findByRoomIdSeq: jest.fn().mockResolvedValue([]),
    ...over,
  };
}

describe("GroupMessageService.getMessagesForModeration — jump to an exact message", () => {
  it("centres the window on the anchor's own sequence number, with no member filter", async () => {
    const anchor = mkRow(ANCHOR_ID, 500);
    const repo = makeRepo({
      findById: jest.fn().mockResolvedValue(anchor),
      findAroundSeq: jest
        .fn()
        .mockResolvedValue([mkRow("b".repeat(24), 499), anchor, mkRow("c".repeat(24), 501)]),
    });

    const page = await makeService(repo).getMessagesForModeration({
      roomId: ROOM_ID,
      seq: null,
      limit: 40,
      aroundMessageId: ANCHOR_ID,
    });

    expect(repo.findById).toHaveBeenCalledWith(ANCHOR_ID);
    expect(repo.findAroundSeq).toHaveBeenCalledWith({
      userId: "",
      roomId: ROOM_ID,
      anchorSeq: 500,
      limit: 40,
    });
    expect(page.found).toBe(true);
    // The requested message is IN the window — that is the whole point of the jump.
    expect(page.items.map((m) => m.messageId ?? m.id)).toContain(ANCHOR_ID);
  });

  it("returns continuation cursors in BOTH directions, so the viewer can page back to the live head", async () => {
    const anchor = mkRow(ANCHOR_ID, 500);
    const repo = makeRepo({
      findById: jest.fn().mockResolvedValue(anchor),
      findAroundSeq: jest
        .fn()
        .mockResolvedValue([mkRow("b".repeat(24), 499), anchor, mkRow("c".repeat(24), 501)]),
      // A neighbour exists on each side, so both "has more" flags are true.
      findByRoomIdSeq: jest.fn().mockResolvedValue([mkRow("d".repeat(24), 498)]),
    });

    const page = await makeService(repo).getMessagesForModeration({
      roomId: ROOM_ID,
      seq: null,
      limit: 40,
      aroundMessageId: ANCHOR_ID,
    });

    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTruthy();
    expect(page.hasMoreNewer).toBe(true);
    expect(page.newerCursor).toBeTruthy();
  });

  it("reports a pin deleted for everyone as not found, and does not fetch a window at all", async () => {
    const repo = makeRepo({
      findById: jest.fn().mockResolvedValue({ ...mkRow(ANCHOR_ID, 500), isDeleted: true }),
    });

    const page = await makeService(repo).getMessagesForModeration({
      roomId: ROOM_ID,
      seq: null,
      limit: 40,
      aroundMessageId: ANCHOR_ID,
    });

    expect(page.found).toBe(false);
    expect(page.items).toEqual([]);
    // No rows to scroll to: asking for a window around a tombstone would return
    // its neighbours and land the viewer on the wrong message.
    expect(repo.findAroundSeq).not.toHaveBeenCalled();
  });

  it("reports a pin that no longer exists as not found", async () => {
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });

    const page = await makeService(repo).getMessagesForModeration({
      roomId: ROOM_ID,
      seq: null,
      limit: 40,
      aroundMessageId: ANCHOR_ID,
    });

    expect(page.found).toBe(false);
    expect(page.items).toEqual([]);
    expect(repo.findAroundSeq).not.toHaveBeenCalled();
  });

  it("refuses an anchor that belongs to another room", async () => {
    const repo = makeRepo({
      findById: jest.fn().mockResolvedValue({ ...mkRow(ANCHOR_ID, 500), roomId: "grp_other" }),
    });

    const page = await makeService(repo).getMessagesForModeration({
      roomId: ROOM_ID,
      seq: null,
      limit: 40,
      aroundMessageId: ANCHOR_ID,
    });

    expect(page.found).toBe(false);
    expect(repo.findAroundSeq).not.toHaveBeenCalled();
  });

  it("without an anchor it still pages ordinary history backwards", async () => {
    const repo = makeRepo({
      findByRoomIdSeq: jest.fn().mockResolvedValue([mkRow("e".repeat(24), 9)]),
    });

    const page = await makeService(repo).getMessagesForModeration({
      roomId: ROOM_ID,
      seq: null,
      limit: 30,
    });

    expect(repo.findById).not.toHaveBeenCalled();
    expect(repo.findByRoomIdSeq).toHaveBeenCalledWith({
      userId: "",
      roomId: ROOM_ID,
      direction: "before",
      seq: null,
      limit: 30,
    });
    expect(page.items).toHaveLength(1);
    expect(page.hasMoreNewer).toBe(false);
  });
});
