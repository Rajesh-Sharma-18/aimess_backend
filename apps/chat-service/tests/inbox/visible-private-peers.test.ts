// Search's room-peer exemption only counts conversations live in the viewer's inbox.
import { PrivateRoomRepository } from "../../src/repositories/private-room.repository.js";

const ME = "user-a";
const CUT = "2026-10-07T06:08:00.000Z";

const room = (roomId: string, peer: string, last: string, extra = {}) => ({
  roomId,
  participants: [ME, peer],
  lastMessageAt: new Date(last),
  deletedFor: {},
  clearFor: {},
  ...extra,
});

it("drops rooms deleted or cleared by the viewer with nothing newer", async () => {
  const findMany = jest.fn(async () => [
    room("r-live", "p-live", "2026-10-07T07:00:00.000Z"),
    room("r-deleted", "p-deleted", "2026-10-07T06:00:00.000Z", {
      deletedFor: { [ME]: CUT },
    }),
    room("r-cleared", "p-cleared", "2026-10-07T06:00:00.000Z", {
      clearFor: { [ME]: CUT },
    }),
    room("r-revived", "p-revived", "2026-10-07T06:30:00.000Z", {
      deletedFor: { [ME]: CUT },
    }),
    room("r-peer-deleted", "p-peer", "2026-10-07T06:00:00.000Z", {
      deletedFor: { "p-peer": CUT },
    }),
  ]);
  const repo = new PrivateRoomRepository({
    privateRoom: { findMany },
  } as never);

  const peers = await repo.findVisiblePeersForUser(ME, 300);

  expect(peers.map((p) => p.peerId)).toEqual(["p-live", "p-revived", "p-peer"]);
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { participants: { has: ME }, lastMessageAt: { not: null } },
    })
  );
});
