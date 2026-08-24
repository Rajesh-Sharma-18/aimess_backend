/**
 * Auto-delete (disappearing messages) and the conversation-list preview.
 *
 * The sweeper deletes through the same `recalculateLastMessageAfterDelete` a
 * manual delete-for-everyone uses, so the row's preview/timestamp is only ever
 * as correct as that recalculation is under CONCURRENCY — and a TTL sweep is
 * the most concurrent caller there is: it expires a whole page of messages at
 * once, each with its own recalculation in flight, while the conversation is
 * still live and receiving new messages.
 *
 * Every case below asserts the snapshot the room is LEFT with, not just the
 * value returned to the caller: a bump built from a stale read is exactly the
 * wrong preview to broadcast, so a contended pass must decline to publish one.
 */
import { GroupMessageService } from "../../src/services/group-message.service.js";
import { PrivateMessageService } from "../../src/services/private-message.service.js";
import { sameSnapshotWhere } from "../../src/lib/last-activity-guard.js";

const ROOM = "prv_room_ad";
const T = (min: number) => new Date(Date.UTC(2026, 7, 20, 10, min, 0));

type Row = {
  id: string;
  senderId: string;
  senderName?: string;
  content: { text: string };
  messageType: string;
  createdAt: Date;
  clientMessageId: string | null;
  sequenceNumber: number;
  revision: number;
  deleted?: boolean;
};

function row(id: string, seq: number, over: Partial<Row> = {}): Row {
  return {
    id,
    senderId: "user-1",
    senderName: "User One",
    content: { text: id },
    messageType: "TEXT",
    createdAt: T(seq),
    clientMessageId: null,
    sequenceNumber: seq,
    revision: seq,
    ...over,
  };
}

/**
 * A room + message table with the ONE behaviour the real repositories have and
 * a plain jest.fn() does not: `setLastMessage` honours `expectLastMessageId`,
 * so a write issued from a snapshot that has since moved is refused.
 */
function makeWorld(messages: Row[], lastMessageId: string | null) {
  const state = {
    messages,
    lastMessageId,
    lastMessageAt:
      messages.find((m) => m.id === lastMessageId)?.createdAt ?? null,
    casRefusals: 0,
  };
  const visible = () =>
    state.messages
      .filter((m) => !m.deleted)
      .sort((a, b) => b.sequenceNumber - a.sequenceNumber);
  const messageRepo = {
    findPreviousVisible: jest.fn(async () => visible()[0] ?? null),
    findPreviousVisibleForUser: jest.fn(async () => visible()[0] ?? null),
  };
  const roomRepo = {
    findByRoomId: jest.fn(async () => ({
      roomId: ROOM,
      lastMessageId: state.lastMessageId,
      lastMessageAt: state.lastMessageAt,
      participants: ["user-1", "user-2"],
    })),
    setLastMessage: jest.fn(
      async (
        _roomId: string,
        message: Row | null,
        opts?: { expectLastMessageId?: string | null }
      ) => {
        if (
          opts &&
          "expectLastMessageId" in opts &&
          (opts.expectLastMessageId ?? null) !== state.lastMessageId
        ) {
          state.casRefusals += 1;
          return false;
        }
        state.lastMessageId = message?.id ?? null;
        state.lastMessageAt = message?.createdAt ?? null;
        return true;
      }
    ),
  };
  return { state, messageRepo, roomRepo };
}

type World = ReturnType<typeof makeWorld>;

function privateService(world: World) {
  return new PrivateMessageService(
    world.messageRepo as never,
    world.roomRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

function groupService(world: World) {
  return new GroupMessageService(
    world.messageRepo as never,
    world.roomRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

describe("auto-delete to lastActivity recalculation (PRIVATE)", () => {
  it("the room's LAST message expires: the preview falls back to the newest surviving message", async () => {
    const m1 = row("m1", 1);
    const world = makeWorld([m1, row("m2", 2, { deleted: true })], "m2");

    const recalc = await privateService(
      world
    ).recalculateLastMessageAfterDelete(ROOM, "m2");

    expect(recalc).toMatchObject({ prevMessageId: "m1", hasLastMessage: true });
    expect(recalc?.createdAt).toEqual(m1.createdAt);
    expect(world.state.lastMessageId).toBe("m1");
  });

  it("EVERY message expires: the snapshot is cleared, not left pointing at a deleted row", async () => {
    const world = makeWorld([row("m1", 1, { deleted: true })], "m1");

    const recalc = await privateService(
      world
    ).recalculateLastMessageAfterDelete(ROOM, "m1");

    expect(recalc).toMatchObject({
      prevMessageId: null,
      hasLastMessage: false,
    });
    // `new Date(0)` is the documented empty-room value the wire turns into
    // `lastMessageAt: 0` — the row sorts to the bottom instead of staying pinned
    // to the top with the deleted message's time.
    expect(recalc?.createdAt.getTime()).toBe(0);
    expect(world.state.lastMessageId).toBeNull();
  });

  it("a NON-LAST message expires: the preview is left exactly as it was", async () => {
    const world = makeWorld(
      [row("m1", 1, { deleted: true }), row("m2", 2)],
      "m2"
    );

    const recalc = await privateService(
      world
    ).recalculateLastMessageAfterDelete(ROOM, "m1");

    expect(recalc).toBeNull();
    expect(world.roomRepo.setLastMessage).not.toHaveBeenCalled();
    expect(world.state.lastMessageId).toBe("m2");
  });

  it("BULK expiry: concurrent recalculations converge on the final state, never on a deleted message", async () => {
    // m2 and m3 are claimed by the same sweep page and deleted together, so both
    // recalculations run against the room at once.
    const world = makeWorld(
      [
        row("m1", 1),
        row("m2", 2, { deleted: true }),
        row("m3", 3, { deleted: true }),
      ],
      "m3"
    );
    const service = privateService(world);

    await Promise.all([
      service.recalculateLastMessageAfterDelete(ROOM, "m3"),
      service.recalculateLastMessageAfterDelete(ROOM, "m2"),
    ]);

    expect(world.state.lastMessageId).toBe("m1");
  });

  it("a NEW message racing the sweep wins: the recalculation stands down instead of rewinding the row", async () => {
    const world = makeWorld(
      [row("m1", 1), row("m2", 2, { deleted: true })],
      "m2"
    );
    // The send lands between this pass's read and its write.
    world.roomRepo.findByRoomId.mockImplementationOnce(async () => {
      const snapshot = {
        roomId: ROOM,
        lastMessageId: world.state.lastMessageId,
        lastMessageAt: world.state.lastMessageAt,
        participants: ["user-1", "user-2"],
      };
      world.state.messages.push(row("m3", 3));
      world.state.lastMessageId = "m3";
      world.state.lastMessageAt = T(3);
      return snapshot;
    });

    const recalc = await privateService(
      world
    ).recalculateLastMessageAfterDelete(ROOM, "m2");

    // Refused once, then the re-read shows m3 is both the snapshot and the
    // newest visible message — nothing to recalculate, and no bump published.
    expect(world.state.casRefusals).toBe(1);
    expect(recalc).toBeNull();
    expect(world.state.lastMessageId).toBe("m3");
  });
});

describe("auto-delete to lastActivity recalculation (GROUP)", () => {
  it("the LAST message expires: the group row falls back to the newest surviving message", async () => {
    const world = makeWorld(
      [row("m1", 1), row("m2", 2, { deleted: true })],
      "m2"
    );

    const recalc = await groupService(world).recalculateLastMessageAfterDelete(
      ROOM,
      "m2"
    );

    expect(recalc).toMatchObject({ prevMessageId: "m1", hasLastMessage: true });
    expect(world.state.lastMessageId).toBe("m1");
  });

  it("BULK expiry: concurrent recalculations converge, never on a deleted message", async () => {
    const world = makeWorld(
      [
        row("m1", 1),
        row("m2", 2, { deleted: true }),
        row("m3", 3, { deleted: true }),
      ],
      "m3"
    );
    const service = groupService(world);

    await Promise.all([
      service.recalculateLastMessageAfterDelete(ROOM, "m3"),
      service.recalculateLastMessageAfterDelete(ROOM, "m2"),
    ]);

    expect(world.state.lastMessageId).toBe("m1");
  });
});

describe("sameSnapshotWhere", () => {
  it("matches the exact snapshot id", () => {
    expect(sameSnapshotWhere("m2")).toEqual({ lastMessageId: "m2" });
  });

  it("accepts both spellings of empty — MongoDB null does NOT match an absent field", () => {
    expect(sameSnapshotWhere(null)).toEqual({
      OR: [{ lastMessageId: null }, { lastMessageId: { isSet: false } }],
    });
  });
});
