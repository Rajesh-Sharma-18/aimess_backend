/**
 * Unit coverage for the group write gate (src/lib/access-guard).
 *
 * Neither frozen state can be read off a membership row: a disband marks every
 * GroupMember LEFT while read access survives, and a super-admin CLOSE leaves
 * them all ACTIVE. So this guard is the only thing standing between a frozen
 * group and a member still writing into it.
 */

import { assertGroupWritable } from "../../src/lib/access-guard.js";

const roomRepo = (room: unknown) =>
  ({ findByRoomId: jest.fn(async () => room) }) as never;

describe("assertGroupWritable", () => {
  it("resolves for an ACTIVE room", async () => {
    await expect(
      assertGroupWritable(
        roomRepo({ roomId: "grp_1", status: "ACTIVE" }),
        "grp_1"
      )
    ).resolves.toBeUndefined();
  });

  it("rejects a DISBANDED room with CHAT_GROUP_DISBANDED (403)", async () => {
    await expect(
      assertGroupWritable(
        roomRepo({ roomId: "grp_1", status: "DISBANDED" }),
        "grp_1"
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      messageKey: "CHAT_GROUP_DISBANDED",
    });
  });

  it("rejects a CLOSED room with CHAT_GROUP_CLOSED_ADMIN_BANNED (403)", async () => {
    await expect(
      assertGroupWritable(
        roomRepo({ roomId: "grp_1", status: "CLOSED" }),
        "grp_1"
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      messageKey: "CHAT_GROUP_CLOSED_ADMIN_BANNED",
    });
  });

  it("rejects a missing room with CHAT_GROUP_NOT_FOUND (404)", async () => {
    await expect(
      assertGroupWritable(roomRepo(null), "grp_gone")
    ).rejects.toMatchObject({
      statusCode: 404,
      messageKey: "CHAT_GROUP_NOT_FOUND",
    });
  });
});
