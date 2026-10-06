/**
 * Suite: POST /streams/:id/stop — creator End Live + community-admin force-end
 *
 * The creator ends their own stream (HOST_ENDED), unchanged. A community ADMIN
 * may also end a MODERATOR's stream for everyone (COMMUNITY_ADMIN_ENDED); every
 * other non-creator gets 403 STREAM_NOT_OWNER with nothing touched. Roles are
 * re-read from community-service on every attempt.
 *
 * The repo fake keeps one in-memory row and implements `claimEnded` the way the
 * real `updateMany({ status: { in: ACTIVE } })` behaves, so the concurrency
 * tests exercise the actual race: both callers pass the status check and the
 * role lookups (which yield to the event loop), and only the atomic claim
 * decides the winner.
 */
import { LivestreamService } from "../../src/services/livestream.service.js";

const publishAdminActivitySafe = jest.fn();
jest.mock("@aimess/messaging", () => ({
  ...jest.requireActual("@aimess/messaging"),
  publishAdminActivitySafe: (...args: unknown[]) =>
    publishAdminActivitySafe(...args),
}));

type Role = "ADMIN" | "MODERATOR" | "MEMBER" | "";
type Member = {
  role: Role;
  status?: string;
  isMember?: boolean;
  closed?: boolean;
};

const CREATOR = "mod-1";
const ADMIN = "admin-1";

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "stream-1",
    communityId: "comm-1",
    creatorId: CREATOR,
    title: "t",
    description: "",
    thumbnail: null,
    sourceType: "PHONE_CAMERA",
    sourceUrl: null,
    streamKey: "key-1",
    playbackId: "public-1",
    provider: null as string | null,
    status: "LIVE",
    hlsUrl: null,
    flvUrl: null,
    dashUrl: null,
    commentStatus: true,
    slowModeSec: null,
    viewerCount: 0,
    peakViewers: 3,
    totalViews: 0,
    totalComments: 0,
    livedAt: new Date(Date.now() - 60_000),
    endedAt: null as Date | null,
    endedReason: null as string | null,
    endedBy: null as string | null,
    createdAt: new Date(Date.now() - 120_000),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup(opts: {
  members?: Record<string, Member>;
  row?: Record<string, unknown>;
  snapshots?: Array<{ userId: string; username: string; displayName: string }>;
  systemBanned?: string[];
  membershipError?: boolean;
}) {
  const members: Record<string, Member> = {
    [CREATOR]: { role: "MODERATOR" },
    [ADMIN]: { role: "ADMIN" },
    ...opts.members,
  };
  let row = makeRow(opts.row);

  const streamRepo = {
    findById: jest.fn(async () => ({ ...row })),
    claimEnded: jest.fn(async (_id: string, end: Record<string, unknown>) => {
      if (row.status === "ENDED") return false;
      row = { ...row, status: "ENDED", ...end };
      return true;
    }),
    updateById: jest.fn(async (_id: string, data: Record<string, unknown>) => {
      row = { ...row, ...data };
      return { ...row };
    }),
    countLiveByCommunity: jest.fn().mockResolvedValue(0),
    countActiveByCommunityAndCreator: jest.fn().mockResolvedValue(0),
    countActiveByCommunity: jest.fn().mockResolvedValue(0),
    listByCommunity: jest.fn(async () => [{ ...row }]),
  };
  const srsService = {
    kickStream: jest.fn().mockResolvedValue(undefined),
    buildPlaybackUrls: jest
      .fn()
      .mockReturnValue({ hlsUrl: "h", flvUrl: "f", dashUrl: "" }),
    hasFrames: jest.fn().mockResolvedValue(true),
  };
  const cdnService = {
    stopPublishing: jest.fn().mockResolvedValue(undefined),
    buildPlaybackUrls: jest
      .fn()
      .mockReturnValue({ hlsUrl: "h", flvUrl: "f", dashUrl: null }),
    qualityUrls: jest.fn().mockReturnValue({}),
  };
  const communityClient = {
    validateMembership: jest.fn(async (_c: string, userId: string) => {
      // Yield, as the real gRPC call does, so concurrent stops interleave.
      await flush();
      if (opts.membershipError) throw new Error("community-service down");
      const m = members[userId];
      const isMember = m ? (m.isMember ?? m.role !== "") : false;
      return {
        isMember,
        role: m?.role ?? "",
        status: m?.status ?? (isMember ? "ACTIVE" : ""),
        isCommunityClosed: Boolean(m?.closed),
      };
    }),
    checkCommunityAccess: jest.fn().mockResolvedValue({
      isMember: true,
      isBanned: false,
      isPublicCommunity: false,
    }),
  };
  const banned = new Set(opts.systemBanned ?? []);
  const redis = {
    get: jest.fn(async (key: string) =>
      [...banned].some((u) => key.includes(u)) ? "1" : null
    ),
    hlen: jest.fn().mockResolvedValue(0),
    publish: jest.fn().mockResolvedValue(undefined),
    hexists: jest.fn().mockResolvedValue(0),
  };
  const banRepo = {
    isBanned: jest.fn().mockResolvedValue(false),
    bannedStreamIds: jest.fn().mockResolvedValue(new Set()),
  };
  const viewerSessionRepo = {
    closeAllOpenForStream: jest.fn().mockResolvedValue(0),
    recordJoin: jest.fn().mockResolvedValue("s"),
  };
  const eventPublisher = jest.fn();
  const userClient = {
    bulkGetUserSnapshots: jest.fn(async (ids: string[]) =>
      (
        opts.snapshots ?? [
          { userId: CREATOR, username: "mod_user", displayName: "Mod Name" },
        ]
      ).filter((s) => ids.includes(s.userId))
    ),
  };

  const service = new LivestreamService(
    streamRepo as any,
    srsService as any,
    communityClient as any,
    redis as any,
    banRepo as any,
    viewerSessionRepo as any,
    eventPublisher,
    userClient as any,
    cdnService as any
  );

  const published = (event: string) =>
    redis.publish.mock.calls
      .map(([, msg]) => JSON.parse(msg as string))
      .filter((m) => m.event === event);
  const endEvents = () => ({
    status: published("stream:status").filter(
      (m) => m.data.status === "ENDED"
    ).length,
    communityEnded: published("community:stream:ended").length,
    domainEnded: eventPublisher.mock.calls.filter(
      ([name]) => name === "stream.ended"
    ).length,
    kicks:
      srsService.kickStream.mock.calls.length +
      cdnService.stopPublishing.mock.calls.length,
    sessionCloses: viewerSessionRepo.closeAllOpenForStream.mock.calls.length,
    audits: publishAdminActivitySafe.mock.calls.length,
  });

  return {
    service,
    streamRepo,
    srsService,
    cdnService,
    communityClient,
    redis,
    eventPublisher,
    userClient,
    published,
    endEvents,
    row: () => row,
  };
}

const ONE_OF_EACH = {
  status: 1,
  communityEnded: 1,
  domainEnded: 1,
  kicks: 1,
  sessionCloses: 1,
  audits: 1,
};
const NONE = {
  status: 0,
  communityEnded: 0,
  domainEnded: 0,
  kicks: 0,
  sessionCloses: 0,
  audits: 0,
};

beforeEach(() => publishAdminActivitySafe.mockClear());

describe("stopStream — creator End Live (unchanged)", () => {
  it("TEST 1/20: a MODERATOR creator ends their own stream as HOST_ENDED, no role lookup", async () => {
    const t = setup({});

    const view = await t.service.stopStream("stream-1", CREATOR);
    await flush();

    expect(view.status).toBe("ENDED");
    expect(view.endedReason).toBe("HOST_ENDED");
    expect(t.row()).toMatchObject({
      status: "ENDED",
      endedReason: "HOST_ENDED",
      endedBy: CREATOR,
    });
    // Authorization ran only for the role DISPLAY hint on the response, never
    // as a gate: an outage below must not stop the creator.
    expect(t.endEvents()).toEqual(ONE_OF_EACH);
    expect(publishAdminActivitySafe).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: CREATOR, actorType: "USER" })
    );
  });

  it("creator stop still works when community-service is down", async () => {
    const t = setup({ membershipError: true });

    const view = await t.service.stopStream("stream-1", CREATOR);

    expect(view.status).toBe("ENDED");
    expect(view.creatorRole).toBeNull();
    expect(t.row().endedReason).toBe("HOST_ENDED");
  });

  it("TEST 20: response keeps the existing StreamView shape and adds the new fields", async () => {
    const t = setup({});

    const view = await t.service.stopStream("stream-1", CREATOR);

    for (const key of [
      "id",
      "communityId",
      "creatorId",
      "title",
      "status",
      "hlsUrl",
      "flvUrl",
      "peakViewers",
      "livedAt",
      "endedAt",
      "createdAt",
      "updatedAt",
    ]) {
      expect(view).toHaveProperty(key);
    }
    expect(view).toMatchObject({
      creatorId: CREATOR,
      creatorRole: "MODERATOR",
      creatorName: "Mod Name",
      endedReason: "HOST_ENDED",
    });
  });

  it("404 STREAM_NOT_FOUND is unchanged", async () => {
    const t = setup({});
    t.streamRepo.findById.mockResolvedValueOnce(null as any);

    await expect(t.service.stopStream("stream-1", ADMIN)).rejects.toMatchObject(
      { message: "STREAM_NOT_FOUND" }
    );
  });
});

describe("stopStream — community admin force-end", () => {
  it("TEST 2/11/12/13: an ADMIN ends a MODERATOR's stream for everyone, exactly once", async () => {
    const t = setup({});

    const view = await t.service.stopStream("stream-1", ADMIN);
    await flush();

    expect(view.status).toBe("ENDED");
    expect(view.endedReason).toBe("COMMUNITY_ADMIN_ENDED");
    expect(t.row()).toMatchObject({
      status: "ENDED",
      creatorId: CREATOR,
      endedReason: "COMMUNITY_ADMIN_ENDED",
      endedBy: ADMIN,
    });
    expect(t.endEvents()).toEqual(ONE_OF_EACH);
    expect(t.srsService.kickStream).toHaveBeenCalledWith(
      "public-1",
      "PHONE_CAMERA"
    );

    // Viewers: stream:status ENDED (with the reason for the host's UI) and
    // community:stream:ended; services: stream.ended naming the acting admin.
    expect(t.published("stream:status")[0].data).toMatchObject({
      status: "ENDED",
      creatorId: CREATOR,
      endedReason: "COMMUNITY_ADMIN_ENDED",
    });
    expect(t.published("community:stream:ended")[0].data).toMatchObject({
      livestreamId: "stream-1",
      reason: "COMMUNITY_ADMIN_ENDED",
    });
    expect(t.eventPublisher).toHaveBeenCalledWith(
      "stream.ended",
      expect.objectContaining({
        streamId: "stream-1",
        communityId: "comm-1",
        creatorId: CREATOR,
        reason: "COMMUNITY_ADMIN_ENDED",
        endedBy: ADMIN,
        endedAt: expect.any(Number),
      })
    );
    // Audit row: the admin is the actor, not the creator and not SYSTEM.
    expect(publishAdminActivitySafe).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ADMIN,
        actorType: "USER",
        targetId: "stream-1",
        after: expect.objectContaining({
          communityId: "comm-1",
          creatorId: CREATOR,
          reason: "COMMUNITY_ADMIN_ENDED",
          endedBy: ADMIN,
        }),
      })
    );
  });

  it("TEST 13: a CDN stream's publisher is stopped via StopLivestreaming exactly once", async () => {
    const t = setup({ row: { provider: "CDN" } });

    await t.service.stopStream("stream-1", ADMIN);

    expect(t.cdnService.stopPublishing).toHaveBeenCalledTimes(1);
    expect(t.srsService.kickStream).not.toHaveBeenCalled();
  });

  it("roles are re-read from community-service for both the admin and the creator", async () => {
    const t = setup({});

    await t.service.stopStream("stream-1", ADMIN);

    expect(t.communityClient.validateMembership).toHaveBeenCalledWith(
      "comm-1",
      ADMIN
    );
    expect(t.communityClient.validateMembership).toHaveBeenCalledWith(
      "comm-1",
      CREATOR
    );
  });

  it.each<[string, string, Record<string, Member>]>([
    ["TEST 3: ADMIN on another ADMIN's stream", ADMIN, { [CREATOR]: { role: "ADMIN" } }],
    ["TEST 4: MODERATOR on another MODERATOR's stream", "mod-2", { "mod-2": { role: "MODERATOR" } }],
    ["TEST 5: MODERATOR on an ADMIN's stream", "mod-2", { [CREATOR]: { role: "ADMIN" }, "mod-2": { role: "MODERATOR" } }],
    ["TEST 6: MEMBER", "member-1", { "member-1": { role: "MEMBER" } }],
    ["TEST 7: non-member", "stranger", {}],
    ["TEST 8: community-BANNED admin", ADMIN, { [ADMIN]: { role: "ADMIN", status: "BANNED", isMember: false } }],
    ["TEST 8: admin who LEFT", ADMIN, { [ADMIN]: { role: "", status: "LEFT", isMember: false } }],
  ])("%s → 403 STREAM_NOT_OWNER, nothing touched (TEST 14)", async (_l, caller, members) => {
    const t = setup({ members });

    await expect(t.service.stopStream("stream-1", caller)).rejects.toMatchObject(
      { message: "STREAM_NOT_OWNER", statusCode: 403 }
    );
    await flush();

    expect(t.streamRepo.claimEnded).not.toHaveBeenCalled();
    expect(t.streamRepo.updateById).not.toHaveBeenCalled();
    expect(t.row().status).toBe("LIVE");
    expect(t.endEvents()).toEqual(NONE);
  });

  it("TEST 8: a platform (Super Admin) banned admin gets ACCOUNT_BANNED", async () => {
    const t = setup({ systemBanned: [ADMIN] });

    await expect(t.service.stopStream("stream-1", ADMIN)).rejects.toMatchObject(
      { message: "ACCOUNT_BANNED", statusCode: 403 }
    );
    expect(t.endEvents()).toEqual(NONE);
  });

  it("fails CLOSED when roles cannot be verified", async () => {
    const t = setup({ membershipError: true });

    await expect(t.service.stopStream("stream-1", ADMIN)).rejects.toMatchObject(
      { message: "STREAM_NOT_OWNER" }
    );
    expect(t.endEvents()).toEqual(NONE);
  });

  it("an ALREADY-ENDED stream is not revealed to an unauthorized caller", async () => {
    const t = setup({ row: { status: "ENDED", endedReason: "HOST_ENDED" } });

    await expect(
      t.service.stopStream("stream-1", "stranger")
    ).rejects.toMatchObject({ message: "STREAM_NOT_OWNER" });
  });

  it("role changed mid-stream: MODERATOR promoted to ADMIN → the admin may no longer end it", async () => {
    const t = setup({});
    const before = await t.service.getStream("stream-1", ADMIN);
    expect(before.creatorRole).toBe("MODERATOR");

    // Promotion does not end a stream (only a demotion to MEMBER does), so it
    // keeps running under the new role; the stale hint must not authorize.
    t.communityClient.validateMembership.mockImplementation(
      async (_c: string, userId: string) => ({
        isMember: true,
        role: "ADMIN",
        status: "ACTIVE",
        isCommunityClosed: false,
        userId,
      })
    );

    await expect(t.service.stopStream("stream-1", ADMIN)).rejects.toMatchObject(
      { message: "STREAM_NOT_OWNER" }
    );
    expect(t.endEvents()).toEqual(NONE);
  });

  it("role changed mid-stream: ADMIN host demoted to MODERATOR → the admin may now end it", async () => {
    const t = setup({ members: { [CREATOR]: { role: "MODERATOR" } } });

    const view = await t.service.stopStream("stream-1", ADMIN);

    expect(view.endedReason).toBe("COMMUNITY_ADMIN_ENDED");
  });

  it("orphan: the host lost broadcast rights (left/removed) but the stream outlived the cleanup → admin may end it", async () => {
    const t = setup({
      members: { [CREATOR]: { role: "", status: "LEFT", isMember: false } },
    });

    const view = await t.service.stopStream("stream-1", ADMIN);

    expect(view.status).toBe("ENDED");
    expect(t.row().endedBy).toBe(ADMIN);
  });

  it("a CLOSED/SUSPENDED community does not block the admin's de-escalating end", async () => {
    const t = setup({ members: { [ADMIN]: { role: "ADMIN", closed: true } } });

    const view = await t.service.stopStream("stream-1", ADMIN);

    expect(view.status).toBe("ENDED");
  });
});

describe("stopStream — idempotency and races", () => {
  it("TEST 9: an admin retry after success is a 200 with the same final state and no second finalization", async () => {
    const t = setup({});

    await t.service.stopStream("stream-1", ADMIN);
    const retry = await t.service.stopStream("stream-1", ADMIN);
    await flush();

    expect(retry.status).toBe("ENDED");
    expect(retry.endedReason).toBe("COMMUNITY_ADMIN_ENDED");
    expect(t.streamRepo.claimEnded).toHaveBeenCalledTimes(1);
    expect(t.endEvents()).toEqual(ONE_OF_EACH);
  });

  it.each([
    ["host first", [CREATOR, ADMIN]],
    ["admin first", [ADMIN, CREATOR]],
  ])(
    "TEST 10: host + admin stop concurrently (%s) → one winner, one finalization, one kick",
    async (_l, callers) => {
      const t = setup({ row: { provider: "CDN" } });

      const [a, b] = await Promise.all(
        callers.map((c) => t.service.stopStream("stream-1", c))
      );
      await flush();

      // Both passed the status check before either claimed.
      expect(t.streamRepo.claimEnded).toHaveBeenCalledTimes(2);
      expect(t.endEvents()).toEqual(ONE_OF_EACH);
      expect(t.cdnService.stopPublishing).toHaveBeenCalledTimes(1);
      // Both callers see the SAME final state — the winner's reason/actor.
      const winner = t.row();
      expect(a.status).toBe("ENDED");
      expect(b.status).toBe("ENDED");
      expect(a.endedReason).toBe(winner.endedReason);
      expect(b.endedReason).toBe(winner.endedReason);
      expect(
        winner.endedReason === "HOST_ENDED"
          ? winner.endedBy === CREATOR
          : winner.endedBy === ADMIN
      ).toBe(true);
    }
  );

  it("TEST 10: two admins racing → one finalization", async () => {
    const t = setup({ members: { "admin-2": { role: "ADMIN" } } });

    await Promise.all([
      t.service.stopStream("stream-1", ADMIN),
      t.service.stopStream("stream-1", "admin-2"),
    ]);
    await flush();

    expect(t.endEvents()).toEqual(ONE_OF_EACH);
  });

  it("Backoffice adminForceEnd racing an app stop → one finalization", async () => {
    const t = setup({});

    const [stop, force] = await Promise.all([
      t.service.stopStream("stream-1", ADMIN),
      t.service.adminForceEnd("stream-1", "POLICY_VIOLATION"),
    ]);
    await flush();

    expect(stop.status).toBe("ENDED");
    expect(force.status).toBe("ENDED");
    expect(t.endEvents().domainEnded).toBe(1);
    expect(t.endEvents().kicks).toBe(1);
  });

  it("Backoffice adminForceEnd flags stream.ended byPlatformAdmin, with no admin identity", async () => {
    const t = setup({});
    await t.service.adminForceEnd("stream-1", "MANUAL_ADMIN");
    await flush();

    const ended = (t.eventPublisher as jest.Mock).mock.calls.find(
      ([name]) => name === "stream.ended"
    )![1];
    expect(ended).toMatchObject({
      reason: "MANUAL_ADMIN",
      endedBy: null,
      byPlatformAdmin: true,
    });
  });

  it("Backoffice adminForceEnd ends a community ADMIN-hosted stream too", async () => {
    const t = setup({ members: { [CREATOR]: { role: "ADMIN" } } });
    const res = await t.service.adminForceEnd("stream-1", "MANUAL_ADMIN");
    await flush();

    expect(res).toEqual({ success: true, status: "ENDED" });
    expect(t.endEvents().domainEnded).toBe(1);
  });

  it("host and community-admin ends never carry byPlatformAdmin", async () => {
    for (const requester of [CREATOR, ADMIN]) {
      const t = setup({});
      await t.service.stopStream("stream-1", requester);
      await flush();
      const ended = (t.eventPublisher as jest.Mock).mock.calls.find(
        ([name]) => name === "stream.ended"
      )![1];
      expect(ended.byPlatformAdmin).toBeUndefined();
      expect(ended.endedBy).toBe(requester);
    }
  });

  it("community-close bulk end racing a host stop counts only the stream it actually ended", async () => {
    const t = setup({});
    (t.streamRepo as any).findActiveByCommunity = jest.fn(async () => [
      { ...t.row() },
    ]);

    const [, bulk] = await Promise.all([
      t.service.stopStream("stream-1", CREATOR),
      t.service.forceEndStreamsByCommunity("comm-1", "COMMUNITY_CLOSED"),
    ]);
    await flush();

    expect(t.endEvents().domainEnded).toBe(1);
    expect(bulk.endedCount + (t.row().endedReason === "HOST_ENDED" ? 1 : 0)).toBe(1);
  });
});

describe("StreamView / socket creator metadata", () => {
  it("TEST 15/16: stream detail carries creatorRole + creatorName", async () => {
    const t = setup({});

    const view = await t.service.getStream("stream-1", ADMIN);

    expect(view).toMatchObject({
      creatorId: CREATOR,
      creatorRole: "MODERATOR",
      creatorName: "Mod Name",
      endedReason: null,
    });
  });

  it("TEST 17: the active-stream list carries the same fields", async () => {
    const t = setup({ members: { [CREATOR]: { role: "ADMIN" } } });

    const { items } = await t.service.listStreams({
      communityId: "comm-1",
      limit: 10,
      requesterId: ADMIN,
    });

    expect(items[0]).toMatchObject({
      creatorId: CREATOR,
      creatorRole: "ADMIN",
      creatorName: "Mod Name",
    });
  });

  it("TEST 18: community:stream:started carries creatorId/creatorRole/creatorName", async () => {
    const t = setup({ row: { status: "PENDING", livedAt: null } });

    await t.service.markLive("stream-1", CREATOR);
    await flush();
    await flush();

    const [started] = t.published("community:stream:started");
    expect(started.data).toMatchObject({
      creatorId: CREATOR,
      creatorRole: "MODERATOR",
      creatorName: "Mod Name",
    });
  });

  it.each([
    ["display name", { displayName: "Shown", username: "handle" }, "Shown"],
    ["username fallback", { displayName: "", username: "handle" }, "handle"],
    ["empty fallback", { displayName: "", username: "" }, ""],
  ])("TEST 19: creatorName — %s", async (_l, snap, expected) => {
    const t = setup({ snapshots: [{ userId: CREATOR, ...snap }] });

    const view = await t.service.getStream("stream-1", ADMIN);

    expect(view.creatorName).toBe(expected);
  });

  it("an unresolvable creator degrades to creatorRole null / creatorName '' instead of failing the read", async () => {
    const t = setup({ membershipError: true });
    t.userClient.bulkGetUserSnapshots.mockRejectedValueOnce(new Error("down"));

    const view = await t.service.getStream("stream-1", ADMIN);

    expect(view).toMatchObject({ creatorRole: null, creatorName: "" });
  });

  it("a creator demoted to MEMBER shows creatorRole null (no host role)", async () => {
    const t = setup({ members: { [CREATOR]: { role: "MEMBER" } } });

    const view = await t.service.getStream("stream-1", ADMIN);

    expect(view.creatorRole).toBeNull();
  });
});
