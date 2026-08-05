/**
 * `assertGroupReadAccess` — widens group message reads past
 * `assertGroupMember`'s ACTIVE-only gate for a member who voluntarily LEFT:
 * they keep read access to history up to (and including) `leftAt`, so the
 * chat stays visible/scrollable but read-only (WhatsApp-style), while every
 * WRITE path stays on the unchanged `assertGroupMember` ACTIVE-only check.
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

  it("denies a kicked member", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "KICKED" });
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
