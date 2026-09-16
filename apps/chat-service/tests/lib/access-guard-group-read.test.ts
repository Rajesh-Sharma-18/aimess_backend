/**
 * `assertGroupReadAccess` — the group READ gate.
 *
 * ACTIVE members read everything. A membership that has ENDED (LEFT, KICKED,
 * BANNED) reads nothing: the group is out of that user's list, so it must not
 * be reachable by holding onto its roomId either. It used to widen LEFT and
 * KICKED to a cutoff-capped read (WhatsApp-style read-only history); that is
 * now reserved for the ONE case where the ROOM itself died — a DISBANDED room,
 * where every membership is marked LEFT and an open client must keep rendering
 * the history it already holds.
 *
 * Every WRITE path stays on the unchanged `assertGroupMember` ACTIVE-only check.
 */
import { ForbiddenError } from "@aimess/errors";
import { assertGroupReadAccess } from "../../src/lib/access-guard.js";

const ROOM_ID = "room-1";
const USER_ID = "usr-1";

const findByRoomAndUser = jest.fn();
const memberRepo = { findByRoomAndUser };
const findByRoomId = jest.fn();
const roomRepo = { findByRoomId };

beforeEach(() => {
  jest.clearAllMocks();
  findByRoomId.mockResolvedValue({ roomId: ROOM_ID, status: "ACTIVE" });
});

const assertRead = () =>
  assertGroupReadAccess(memberRepo, ROOM_ID, USER_ID, roomRepo);

describe("assertGroupReadAccess", () => {
  it("grants full read access (no cutoff) to an ACTIVE member", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "ACTIVE" });
    const result = await assertRead();
    expect(result.readCutoffBefore).toBeUndefined();
    // Hot path: an ACTIVE member never pays for the room lookup.
    expect(findByRoomId).not.toHaveBeenCalled();
  });

  it("denies a member who left a live group", async () => {
    findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
      leftAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await expect(assertRead()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("denies a REMOVED (kicked) member of a live group", async () => {
    findByRoomAndUser.mockResolvedValue({
      status: "KICKED",
      kickedAt: new Date("2026-02-02T00:00:00.000Z"),
    });
    await expect(assertRead()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("denies a LEFT row with no leftAt timestamp (defensive — should never happen)", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "LEFT", leftAt: null });
    await expect(assertRead()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("denies a KICKED row with no kickedAt timestamp (defensive)", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "KICKED", kickedAt: null });
    await expect(assertRead()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("denies a banned member", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "BANNED" });
    await expect(assertRead()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("denies a user who was never a member", async () => {
    findByRoomAndUser.mockResolvedValue(null);
    await expect(assertRead()).rejects.toBeInstanceOf(ForbiddenError);
  });

  describe("DISBANDED room — the one surviving widening", () => {
    const DISBANDED_AT = new Date("2026-03-03T00:00:00.000Z");

    beforeEach(() => {
      findByRoomId.mockResolvedValue({
        roomId: ROOM_ID,
        status: "DISBANDED",
        disbandedAt: DISBANDED_AT,
      });
    });

    it("grants read access capped at the disband instant", async () => {
      findByRoomAndUser.mockResolvedValue({
        status: "LEFT",
        leftAt: DISBANDED_AT,
      });
      const result = await assertRead();
      expect(result.readCutoffBefore).toEqual(DISBANDED_AT);
    });

    it("still denies a member who had left BEFORE the disband", async () => {
      // Their access ended when they left; the room dying later must not hand
      // it back. Only a membership the disband itself ended (leftAt === the
      // room's disbandedAt) is admitted.
      findByRoomAndUser.mockResolvedValue({
        status: "LEFT",
        leftAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      await expect(assertRead()).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("still denies a member an admin removed before the disband", async () => {
      findByRoomAndUser.mockResolvedValue({
        status: "KICKED",
        kickedAt: new Date("2026-02-02T00:00:00.000Z"),
      });
      await expect(assertRead()).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
