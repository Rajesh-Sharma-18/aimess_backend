/**
 * Unit coverage for the group disband write gate (src/lib/access-guard).
 *
 * Disband deliberately leaves every GroupMember row ACTIVE — that is what keeps
 * the history readable — so no membership check can tell a live group from a
 * disbanded one. This guard is the only thing standing between a disbanded
 * group and a member still sending into it.
 */

import { assertGroupNotDisbanded } from "../../src/lib/access-guard.js";

const roomRepo = (room: unknown) =>
  ({ findByRoomId: jest.fn(async () => room) }) as never;

describe("assertGroupNotDisbanded", () => {
  it("resolves for an ACTIVE room", async () => {
    await expect(
      assertGroupNotDisbanded(
        roomRepo({ roomId: "grp_1", status: "ACTIVE" }),
        "grp_1"
      )
    ).resolves.toBeUndefined();
  });

  it("rejects a DISBANDED room with CHAT_GROUP_DISBANDED (403)", async () => {
    await expect(
      assertGroupNotDisbanded(
        roomRepo({ roomId: "grp_1", status: "DISBANDED" }),
        "grp_1"
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      messageKey: "CHAT_GROUP_DISBANDED",
    });
  });

  it("rejects a missing room with CHAT_GROUP_NOT_FOUND (404)", async () => {
    await expect(
      assertGroupNotDisbanded(roomRepo(null), "grp_gone")
    ).rejects.toMatchObject({
      statusCode: 404,
      messageKey: "CHAT_GROUP_NOT_FOUND",
    });
  });
});
