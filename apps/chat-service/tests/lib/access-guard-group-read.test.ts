/**
 * `assertGroupReadAccess` — widens group message reads past
 * `assertGroupMember`'s ACTIVE-only gate for a member who voluntarily LEFT or
 * was REMOVED (kicked) by an admin: they keep read access to history up to
 * (and including) `leftAt`/`kickedAt`, so the chat stays visible/scrollable but
 * read-only (WhatsApp-style), while every WRITE path stays on the unchanged
 * `assertGroupMember` ACTIVE-only check. BANNED stays denied on both axes.
 */
import { ForbiddenError } from "@aimess/errors";
import { assertGroupReadAccess } from "../../src/lib/access-guard.js";

const ROOM_ID = "room-1";
const USER_ID = "usr-1";

const findByRoomAndUser = jest.fn();
const memberRepo = { findByRoomAndUser };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("assertGroupReadAccess", () => {
  it("grants full read access (no cutoff) to an ACTIVE member", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "ACTIVE" });
    const result = await assertGroupReadAccess(memberRepo, ROOM_ID, USER_ID);
    expect(result.readCutoffBefore).toBeUndefined();
  });

  it("grants read access capped at leftAt for a member who left", async () => {
    const leftAt = new Date("2026-01-01T00:00:00.000Z");
    findByRoomAndUser.mockResolvedValue({ status: "LEFT", leftAt });
    const result = await assertGroupReadAccess(memberRepo, ROOM_ID, USER_ID);
    expect(result.readCutoffBefore).toEqual(leftAt);
  });

  it("denies a LEFT row with no leftAt timestamp (defensive — should never happen)", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "LEFT", leftAt: null });
    await expect(
      assertGroupReadAccess(memberRepo, ROOM_ID, USER_ID)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("grants read access capped at kickedAt for a REMOVED member", async () => {
    const kickedAt = new Date("2026-02-02T00:00:00.000Z");
    findByRoomAndUser.mockResolvedValue({ status: "KICKED", kickedAt });
    const result = await assertGroupReadAccess(memberRepo, ROOM_ID, USER_ID);
    expect(result.readCutoffBefore).toEqual(kickedAt);
  });

  it("denies a KICKED row with no kickedAt timestamp (defensive)", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "KICKED", kickedAt: null });
    await expect(
      assertGroupReadAccess(memberRepo, ROOM_ID, USER_ID)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("denies a banned member", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "BANNED" });
    await expect(
      assertGroupReadAccess(memberRepo, ROOM_ID, USER_ID)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("denies a user who was never a member", async () => {
    findByRoomAndUser.mockResolvedValue(null);
    await expect(
      assertGroupReadAccess(memberRepo, ROOM_ID, USER_ID)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
