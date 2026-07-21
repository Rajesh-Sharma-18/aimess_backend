/**
 * REVISION WRITE-PATH GUARD (private + group).
 *
 * The zero-loss `/changes` feed is only correct if EVERY content mutation stamps a fresh
 * per-room `revision`. Miss one path and `/changes` silently omits those mutations —
 * clients sync "successfully" while showing stale content, and no feature test that only
 * exercises the remembered paths will catch it.
 *
 * So this drives every mutating repository method against a fake prisma + a counting
 * room repo, and asserts:
 *   - each CONTENT mutation allocated a revision AND wrote it onto the row
 *   - the per-user view-state paths (delete-for-me, delivery receipts) allocate NOTHING
 *
 * A new write path added without a revision fails here.
 */
import { PrivateMessageRepository } from "../../src/repositories/private-message.repository.js";
import { GroupMessageRepository } from "../../src/repositories/group-message.repository.js";

const PRIVATE_ROOM = "prv_TESTROOM";
const GROUP_ROOM = "grp_TESTROOM";
const MSG = "a".repeat(24);
const USER = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";

/** Captures the `data` of every create/update so we can assert on `revision`. */
function makeHarness(model: "privateMessage" | "groupMessage") {
  const writes: Array<Record<string, unknown>> = [];
  let revisionCounter = 0;

  const allocateRevision = jest.fn(async () => {
    revisionCounter += 1;
    return revisionCounter;
  });

  const row = {
    id: MSG,
    roomId: model === "privateMessage" ? PRIVATE_ROOM : GROUP_ROOM,
    content: { text: "before" },
    editHistory: [],
    deletedFor: {},
    deletedForUserIds: [],
    deliveredTo: [],
    createdAt: new Date(),
  };

  const modelStub = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data);
      return { ...row, ...data };
    }),
    update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data);
      return { ...row, ...data };
    }),
    findUnique: jest.fn(async () => row),
    findMany: jest.fn(async () => [row]),
    count: jest.fn(async () => 1),
  };

  const prisma = { [model]: modelStub } as never;
  const roomRepo = { allocateRevision } as never;

  return {
    prisma,
    roomRepo,
    writes,
    allocateRevision,
    lastWrite: () => writes[writes.length - 1] ?? {},
    reset: () => {
      writes.length = 0;
      allocateRevision.mockClear();
    },
  };
}

describe("revision write-path guard — PrivateMessageRepository", () => {
  const h = makeHarness("privateMessage");
  const repo = new PrivateMessageRepository(h.prisma, h.roomRepo);

  beforeEach(() => h.reset());

  it("createMessage stamps a revision", async () => {
    await repo.createMessage({ roomId: PRIVATE_ROOM, senderId: USER });
    expect(h.allocateRevision).toHaveBeenCalledWith(PRIVATE_ROOM);
    expect(typeof h.lastWrite().revision).toBe("number");
  });

  it("createForwardedMessage stamps a revision on the TARGET room", async () => {
    await repo.createForwardedMessage({
      roomId: PRIVATE_ROOM,
      senderId: USER,
      receiverId: PEER,
      content: { text: "fwd" },
      messageType: "TEXT",
      forwardData: {},
    });
    expect(h.allocateRevision).toHaveBeenCalledWith(PRIVATE_ROOM);
    expect(typeof h.lastWrite().revision).toBe("number");
  });

  it("addReactions stamps a revision", async () => {
    await repo.addReactions(MSG, PRIVATE_ROOM, { "👍": [] });
    expect(h.allocateRevision).toHaveBeenCalledWith(PRIVATE_ROOM);
    expect(typeof h.lastWrite().revision).toBe("number");
  });

  it("editMessage stamps a revision", async () => {
    await repo.editMessage(MSG, PRIVATE_ROOM, { text: "after" });
    expect(h.allocateRevision).toHaveBeenCalledWith(PRIVATE_ROOM);
    expect(typeof h.lastWrite().revision).toBe("number");
  });

  it("deleteForEveryone stamps a revision (tombstone must replay)", async () => {
    await repo.deleteForEveryone(MSG, PRIVATE_ROOM, USER);
    expect(h.allocateRevision).toHaveBeenCalledWith(PRIVATE_ROOM);
    expect(typeof h.lastWrite().revision).toBe("number");
  });

  it("deleteForMe allocates NOTHING — per-user view state", async () => {
    await repo.deleteForMe(MSG, USER);
    expect(h.allocateRevision).not.toHaveBeenCalled();
    expect(h.lastWrite().revision).toBeUndefined();
  });

  it("markDeliveredUpTo allocates NOTHING — delivery receipt, not content", async () => {
    await repo.markDeliveredUpTo(PRIVATE_ROOM, PEER, MSG);
    expect(h.allocateRevision).not.toHaveBeenCalled();
  });
});

describe("revision write-path guard — GroupMessageRepository", () => {
  const h = makeHarness("groupMessage");
  const repo = new GroupMessageRepository(h.prisma, h.roomRepo);

  beforeEach(() => h.reset());

  it("create stamps a revision", async () => {
    await repo.create({ roomId: GROUP_ROOM, senderId: USER });
    expect(h.allocateRevision).toHaveBeenCalledWith(GROUP_ROOM);
    expect(typeof h.lastWrite().revision).toBe("number");
  });

  it("createForwardedMessage stamps a revision on the TARGET room", async () => {
    await repo.createForwardedMessage({
      roomId: GROUP_ROOM,
      senderId: USER,
      senderName: "Tester",
      senderAvatar: "",
      content: { text: "fwd" },
      messageType: "TEXT",
      forwardData: {},
    });
    expect(h.allocateRevision).toHaveBeenCalledWith(GROUP_ROOM);
    expect(typeof h.lastWrite().revision).toBe("number");
  });

  it("addReactions stamps a revision", async () => {
    await repo.addReactions(MSG, GROUP_ROOM, { "👍": [] });
    expect(h.allocateRevision).toHaveBeenCalledWith(GROUP_ROOM);
    expect(typeof h.lastWrite().revision).toBe("number");
  });

  it("editMessage stamps a revision", async () => {
    await repo.editMessage(MSG, GROUP_ROOM, { text: "after" });
    expect(h.allocateRevision).toHaveBeenCalledWith(GROUP_ROOM);
    expect(typeof h.lastWrite().revision).toBe("number");
  });

  it("deleteForEveryone stamps a revision (tombstone must replay)", async () => {
    await repo.deleteForEveryone(MSG, GROUP_ROOM, USER, "SELF_DELETE");
    expect(h.allocateRevision).toHaveBeenCalledWith(GROUP_ROOM);
    expect(typeof h.lastWrite().revision).toBe("number");
  });

  it("deleteForMe allocates NOTHING — per-user view state", async () => {
    await repo.deleteForMe(MSG, USER);
    expect(h.allocateRevision).not.toHaveBeenCalled();
    expect(h.lastWrite().revision).toBeUndefined();
  });
});
