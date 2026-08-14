/**
 * `ensurePrivateRoom` — the ungated get-or-create the friendship consumer uses
 * so the "You and X are now friends" SYSTEM message has a room to land in.
 */
import { ensurePrivateRoom } from "../../src/services/private-room.service.js";
import { invalidateAccountChatSettings } from "../../src/lib/account-chat-settings.js";
import { userGrpcClient } from "../../src/grpc/user-snapshot.client.js";

/** Point the (mocked) user-service at one account-wide Settings → Chat value. */
function setAccountDefault(settings: Record<string, unknown>): void {
  (userGrpcClient.getChatSettings as jest.Mock).mockResolvedValue({
    autoDeleteTimer: "OFF",
    autoDeleteDefaultMode: "",
    autoDeleteDefaultTtlSeconds: null,
    typingIndicators: true,
    readReceipts: true,
    ...settings,
  });
}

beforeEach(() => {
  invalidateAccountChatSettings();
  setAccountDefault({});
});

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

/**
 * "Default message timer for new private chats" — the account-wide Profile
 * setting. It touches a room at exactly ONE moment: creation. Afterwards the
 * room policy is shared with the peer and independent, so a later change to the
 * account default must not silently rewrite conversations someone else is in.
 */
describe("ensurePrivateRoom — Profile default snapshot", () => {
  it("snapshots the INITIATOR's canonical default into a brand-new room", async () => {
    setAccountDefault({
      autoDeleteDefaultMode: "TIMER",
      autoDeleteDefaultTtlSeconds: 604800,
    });
    const deps = buildDeps(null);

    await ensurePrivateRoom(deps, "user-a", "user-b");

    const [created] = deps.privateRoomRepo.create.mock.calls[0]!;
    expect(created.autoDelete).toMatchObject({
      mode: "TIMER",
      ttlSeconds: 604800,
      setBy: "user-a",
    });
  });

  it("dual-reads the LEGACY enum while the canonical default is unset", async () => {
    // `autoDeleteDefaultMode: ""` means the user has never saved the canonical
    // setting, so their existing legacy choice must keep applying.
    setAccountDefault({ autoDeleteTimer: "DAYS_30" });
    const deps = buildDeps(null);

    await ensurePrivateRoom(deps, "user-a", "user-b");

    const [created] = deps.privateRoomRepo.create.mock.calls[0]!;
    expect(created.autoDelete).toMatchObject({
      mode: "TIMER",
      ttlSeconds: 2592000,
    });
  });

  it("lets the CANONICAL default win over a stale legacy enum", async () => {
    setAccountDefault({
      autoDeleteTimer: "DAYS_30",
      autoDeleteDefaultMode: "OFF",
    });
    const deps = buildDeps(null);

    await ensurePrivateRoom(deps, "user-a", "user-b");

    const [created] = deps.privateRoomRepo.create.mock.calls[0]!;
    expect(created.autoDelete).toBeUndefined();
  });

  it("writes no policy at all when the default is OFF", async () => {
    const deps = buildDeps(null);

    await ensurePrivateRoom(deps, "user-a", "user-b");

    const [created] = deps.privateRoomRepo.create.mock.calls[0]!;
    // Absent, not `{mode:"OFF"}` — a room with no record reads as Off already,
    // and writing one would allocate a policy version nobody set.
    expect(created.autoDelete).toBeUndefined();
  });

  it("does NOT touch an EXISTING room, whatever the account default says", async () => {
    setAccountDefault({
      autoDeleteDefaultMode: "TIMER",
      autoDeleteDefaultTtlSeconds: 86400,
    });
    const deps = buildDeps({ roomId: "prv_existing" });

    await ensurePrivateRoom(deps, "user-a", "user-b");

    expect(deps.privateRoomRepo.create).not.toHaveBeenCalled();
  });

  it("still creates the room when the settings lookup fails (fails OPEN)", async () => {
    (userGrpcClient.getChatSettings as jest.Mock).mockRejectedValue(
      new Error("user-service down")
    );
    const deps = buildDeps(null);

    const room = await ensurePrivateRoom(deps, "user-a", "user-b");

    expect(room.roomId).toBe("prv_new");
    const [created] = deps.privateRoomRepo.create.mock.calls[0]!;
    expect(created.autoDelete).toBeUndefined();
  });
});
