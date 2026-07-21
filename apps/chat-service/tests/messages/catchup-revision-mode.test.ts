/**
 * SOCKET CATCH-UP — REVISION MODE (private + group).
 *
 * `chat:catchup` gained a `sinceRevision` cursor that switches the room off the
 * insert-only `sequenceNumber` axis onto the zero-loss CHANGE axis. Two ways this
 * silently breaks:
 *   - a client that never opted in gets routed onto the revision axis anyway
 *     (would drop its whole backlog, since old rows have revision 0);
 *   - `sinceRevision: 0` — a VALID cold start — is mistaken for "not set".
 *
 * So this asserts which repository query each mode reaches, and that the deep-gap
 * horizon short-circuits before querying at all.
 */
import { PrivateMessageService } from "../../src/services/private-message.service.js";
import { GroupMessageService } from "../../src/services/group-message.service.js";

const PRIVATE_ROOM = "prv_TESTROOM";
const GROUP_ROOM = "grp_TESTROOM";
const USER = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const ROOM_REVISION = 42;

function makeRow(seq: number, revision: number) {
  return {
    id: `${"a".repeat(23)}${seq}`,
    roomId: PRIVATE_ROOM,
    sequenceNumber: seq,
    revision,
    deletedFor: {},
    deletedForUserIds: [],
    createdAt: new Date(),
  };
}

/** Stubs both axes so a test can assert which one the service actually used. */
function makeRepos(roomRevision = ROOM_REVISION) {
  const findAfterSeq = jest.fn(async () => [makeRow(9, 0)]);
  const findByRoomIdRevisionSince = jest.fn(async () => ({
    messages: [makeRow(9, 8)],
    hasMore: false,
    nextRevision: 8,
  }));
  const getRoomRevision = jest.fn(async () => roomRevision);

  return {
    messageRepo: { findAfterSeq, findByRoomIdRevisionSince } as never,
    privateRoomRepo: {
      getRoomRevision,
      findByRoomId: jest.fn(async () => ({
        roomId: PRIVATE_ROOM,
        participants: [USER, PEER],
      })),
    } as never,
    groupRoomRepo: { getRoomRevision } as never,
    memberRepo: {
      findActiveByRoomAndUser: jest.fn(async () => ({
        roomId: GROUP_ROOM,
        userId: USER,
        status: "active",
      })),
    } as never,
    findAfterSeq,
    findByRoomIdRevisionSince,
    getRoomRevision,
  };
}

function makePrivate(h: ReturnType<typeof makeRepos>) {
  return new PrivateMessageService(
    h.messageRepo,
    h.privateRoomRepo,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

function makeGroup(h: ReturnType<typeof makeRepos>) {
  return new GroupMessageService(
    h.messageRepo,
    h.groupRoomRepo,
    h.memberRepo,
    {} as never,
    {} as never
  );
}

const KINDS: Array<
  [
    string,
    (h: ReturnType<typeof makeRepos>) => {
      catchup: (p: never) => Promise<unknown>;
    },
    string,
  ]
> = [
  ["private", (h) => makePrivate(h) as never, PRIVATE_ROOM],
  ["group", (h) => makeGroup(h) as never, GROUP_ROOM],
];

describe("catchup — legacy sinceSeq mode is untouched", () => {
  it.each(KINDS)(
    "%s: omitting sinceRevision uses the sequenceNumber axis",
    async (_kind, make, roomId) => {
      const h = makeRepos();
      const res = await make(h).catchup({
        roomId,
        userId: USER,
        sinceSeq: 5,
        limit: 50,
      });

      expect(h.findAfterSeq).toHaveBeenCalled();
      expect(h.findByRoomIdRevisionSince).not.toHaveBeenCalled();
      // Revision fields stay neutral so a legacy client can't misread them as a cursor.
      expect(res.lastRevision).toBe(0);
      expect(res.roomRevision).toBe(0);
      expect(res.resetRequired).toBe(false);
    }
  );
});

describe("catchup — revision mode", () => {
  it.each(KINDS)(
    "%s: sinceRevision switches to the CHANGE axis",
    async (_kind, make, roomId) => {
      const h = makeRepos();
      const res = await make(h).catchup({
        roomId,
        userId: USER,
        sinceSeq: 5,
        sinceRevision: 7,
        limit: 50,
      });

      expect(h.findByRoomIdRevisionSince).toHaveBeenCalledWith(
        expect.objectContaining({ sinceRevision: 7, limit: 50 })
      );
      expect(h.findAfterSeq).not.toHaveBeenCalled();
      expect(res.lastRevision).toBe(8);
      expect(res.roomRevision).toBe(ROOM_REVISION);
      // lastSeq still tracks the page so a client mixing both cursors stays consistent.
      expect(res.lastSeq).toBe(9);
    }
  );

  it.each(KINDS)(
    "%s: sinceRevision=0 is a cold start, NOT 'unset' and NOT a reset",
    async (_kind, make, roomId) => {
      const h = makeRepos();
      const res = await make(h).catchup({
        roomId,
        userId: USER,
        sinceSeq: 0,
        sinceRevision: 0,
        limit: 50,
      });

      expect(h.findByRoomIdRevisionSince).toHaveBeenCalledWith(
        expect.objectContaining({ sinceRevision: 0 })
      );
      expect(h.findAfterSeq).not.toHaveBeenCalled();
      expect(res.resetRequired).toBe(false);
    }
  );

  it.each(KINDS)(
    "%s: a cursor past the horizon short-circuits to resetRequired",
    async (_kind, make, roomId) => {
      const h = makeRepos(50_000);
      const res = await make(h).catchup({
        roomId,
        userId: USER,
        sinceSeq: 0,
        sinceRevision: 1,
        limit: 50,
      });

      expect(res.resetRequired).toBe(true);
      expect(res.events).toEqual([]);
      expect(res.roomRevision).toBe(50_000);
      // Short-circuits BEFORE the page query — the point of the horizon.
      expect(h.findByRoomIdRevisionSince).not.toHaveBeenCalled();
    }
  );

  it.each(KINDS)(
    "%s: an unauthorized viewer never reaches either axis",
    async (_kind, make, roomId) => {
      const h = makeRepos();
      (
        h.privateRoomRepo as unknown as { findByRoomId: jest.Mock }
      ).findByRoomId = jest.fn(async () => null);
      (
        h.memberRepo as unknown as { findActiveByRoomAndUser: jest.Mock }
      ).findActiveByRoomAndUser = jest.fn(async () => null);

      const res = await make(h).catchup({
        roomId,
        userId: USER,
        sinceSeq: 0,
        sinceRevision: 0,
        limit: 50,
      });

      expect(res.authorized).toBe(false);
      expect(h.findByRoomIdRevisionSince).not.toHaveBeenCalled();
      expect(h.findAfterSeq).not.toHaveBeenCalled();
    }
  );
});
