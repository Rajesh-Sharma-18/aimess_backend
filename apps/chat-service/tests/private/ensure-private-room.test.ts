/**
 * `ensurePrivateRoom` — the ungated get-or-create the friendship consumer uses
 * so the "You and X are now friends" SYSTEM message has a room to land in.
 */
import { ensurePrivateRoom } from "../../src/services/private-room.service.js";

const buildDeps = (existing: unknown) => {
  const created = { roomId: "prv_new" };
  return {
    privateRoomRepo: {
      findByParticipantsKey: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockResolvedValue(created),
    },
    userSnapshotService: {
      getUserSnapshotsMap: jest.fn().mockResolvedValue(new Map()),
    },
    cacheRepo: {},
    redis: { publish: jest.fn().mockResolvedValue(1) },
  } as never as Parameters<typeof ensurePrivateRoom>[0] & {
    privateRoomRepo: { create: jest.Mock };
    redis: { publish: jest.Mock };
  };
};

describe("ensurePrivateRoom", () => {
  it("creates the room and announces it to BOTH participants when none exists", async () => {
    const deps = buildDeps(null);

    const room = await ensurePrivateRoom(deps, "user-a", "user-b");

    expect(room.roomId).toBe("prv_new");
    expect(deps.privateRoomRepo.create).toHaveBeenCalledTimes(1);
    const channels = deps.redis.publish.mock.calls.map((c) => c[0]);
    expect(channels).toEqual(["user:user-a", "user:user-b"]);
    expect(
      JSON.parse(deps.redis.publish.mock.calls[0]![1] as string).event
    ).toBe("conv:created");
  });

  it("is idempotent: an existing room is returned untouched and re-announces nothing", async () => {
    const deps = buildDeps({ roomId: "prv_existing" });

    const room = await ensurePrivateRoom(deps, "user-a", "user-b");

    expect(room.roomId).toBe("prv_existing");
    expect(deps.privateRoomRepo.create).not.toHaveBeenCalled();
    expect(deps.redis.publish).not.toHaveBeenCalled();
  });
});
