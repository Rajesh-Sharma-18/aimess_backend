/**
 * Integration tests — GROUP roster realtime fan-out, the group counterpart of
 * community's `community:member:removed` / `community:member:updated`.
 *
 * Remove-member and role-change previously wrote the DB row and posted a SYSTEM
 * message, and nothing else: a member sitting on the chat LIST (who never
 * called `conv:join`) heard nothing, so member counts, role badges and the
 * target's own permissions stayed stale until a manual refetch. These tests
 * pin the two legs that fix it — the room broadcast AND every active member's
 * personal `user:<id>` channel (the multi-device leg).
 */
import request from "supertest";

import { GroupMemberService } from "../../src/services/group-member.service.js";
import { GroupSystemMessageService } from "../../src/services/group-system-message.service.js";
import { UserSnapshotService } from "../../src/services/user-snapshot.service.js";
import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_roster_rt";
const TARGET = "target-user-1";
const BYSTANDER = "bystander-1";

/** Every `redis.publish` call as `{ channel, event, data }`. */
function publishes(): Array<{ channel: string; event: string; data: any }> {
  return mocks.redis.publish.mock.calls.map(
    ([channel, raw]: [string, string]) => ({
      channel,
      ...(JSON.parse(raw) as { event: string; data: any }),
    })
  );
}

/** Channels an event was delivered on, via redis.publish AND publishChatUserEvent. */
function channelsFor(event: string): string[] {
  return publishes()
    .filter((p) => p.event === event)
    .map((p) => p.channel)
    .sort();
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  // Roster AFTER the write: the removed member is already gone.
  mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
    { userId: TEST_USER_ID },
    { userId: BYSTANDER },
  ]);
  mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
    roomId: ROOM,
    name: "Testing Invites",
    memberCount: 2,
    memberLimit: 200,
  });
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
    async (_roomId: string, userId: string) =>
      userId === TEST_USER_ID
        ? { userId: TEST_USER_ID, role: "ADMIN" }
        : { userId: TARGET, role: "MEMBER" }
  );
});

describe("POST /api/chat/group-members/kick", () => {
  it("REALTIME: group:member:removed reaches the room and every remaining member", async () => {
    mocks.groupMemberRepo.updateStatus.mockResolvedValue({
      userId: TARGET,
      status: "KICKED",
    });

    const res = await request(app)
      .post("/api/chat/group-members/kick")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(200);
    expect(channelsFor("group:member:removed")).toEqual([
      `conv:${ROOM}`,
      `user:${TEST_USER_ID}`,
      `user:${BYSTANDER}`,
    ]);
    const removed = publishes().find(
      (p) => p.event === "group:member:removed"
    )!;
    expect(removed.data).toMatchObject({
      roomId: ROOM,
      conversationType: "GROUP",
      memberId: TARGET,
      actorId: TEST_USER_ID,
      reason: "KICK",
      memberCount: 2,
    });
    // The removed member still gets their own eviction signal (unchanged).
    expect(channelsFor("group:removed")).toEqual([`user:${TARGET}`]);
  });
});

/**
 * Adding was the ONLY membership change with no roster fan-out: the DB row and
 * the room's memberCount both moved, but nobody already in the group heard
 * about it, so the admin's own "255/256 Members" stayed put until a hard
 * reload. It reuses `group:member:updated` (same payload shape, same consumers)
 * rather than minting a third roster event.
 */
describe("POST /api/chat/group-members/add", () => {
  beforeEach(() => {
    mocks.groupMemberRepo.upsert.mockResolvedValue({
      userId: TARGET,
      role: "MEMBER",
      status: "ACTIVE",
      joinedAt: new Date(),
    });
  });

  it("REALTIME: an add announces the new roster to the room and every member", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(201);
    expect(channelsFor("group:member:updated")).toEqual([
      `conv:${ROOM}`,
      `user:${TEST_USER_ID}`,
      `user:${BYSTANDER}`,
    ]);
    expect(
      publishes().find((p) => p.event === "group:member:updated")!.data
    ).toMatchObject({
      roomId: ROOM,
      conversationType: "GROUP",
      memberId: TARGET,
      role: "MEMBER",
      actorId: TEST_USER_ID,
      memberCount: 2,
    });
  });

  it("RE-ADD: a KICKED row is re-admitted as ACTIVE with every KICK field cleared (a ban is not)", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      userId: TARGET,
      status: "KICKED",
      kickedAt: new Date(),
      kickedBy: TEST_USER_ID,
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(201);
    expect(mocks.groupMemberRepo.upsert).toHaveBeenCalledWith(
      ROOM,
      TARGET,
      expect.objectContaining({
        status: "ACTIVE",
        leftAt: null,
        kickedAt: null,
        kickedBy: null,
        kickReason: null,
      })
    );
    // Groups have no ban; the add never writes ban columns.
    expect(mocks.groupMemberRepo.upsert.mock.calls[0][2]).not.toHaveProperty(
      "bannedAt"
    );
    // The re-added member's own channel is what un-sticks their client.
    expect(channelsFor("group:added")).toEqual([`user:${TARGET}`]);
  });

  it("RE-ADD: a stale MODERATOR cannot re-add a removed member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      userId: TEST_USER_ID,
      role: "MODERATOR",
      status: "ACTIVE",
    });
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      userId: TARGET,
      status: "KICKED",
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(403);
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("CAPACITY: a full group rejects a NEW member but the already-ACTIVE case is not a capacity error", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      name: "Testing Invites",
      memberCount: 256,
      memberLimit: 256,
    });

    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);
    const full = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "brand-new-user" });
    expect(full.status).toBe(400);

    // Same full room, but the target is already in it: the membership check has
    // to run FIRST, or "already a member" is misreported as "group is full".
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      userId: TARGET,
      status: "ACTIVE",
    });
    const dupe = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });
    expect(dupe.status).toBe(409);
  });
});

describe("POST /api/chat/group-members/role", () => {
  it("REALTIME: a leader hand-off announces BOTH changed rows", async () => {
    mocks.groupMemberRepo.transferLeadership.mockResolvedValue(true);

    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET, role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(channelsFor("group:member:updated")).toEqual(
      expect.arrayContaining([`conv:${ROOM}`, `user:${BYSTANDER}`])
    );
    const updates = publishes().filter(
      (p) => p.event === "group:member:updated" && p.channel === `conv:${ROOM}`
    );
    expect(updates.map((u) => [u.data.memberId, u.data.role])).toEqual([
      [TARGET, "ADMIN"],
      [TEST_USER_ID, "MEMBER"],
    ]);
  });
});

describe("GroupMemberService.kick (backoffice removal)", () => {
  /**
   * The removed member must NEVER receive the room event/line announcing their
   * own removal. The room broadcast of both the roster event AND the MEMBER_REMOVED
   * system line carry an envelope-level `excludeUserId` the gateway honors to
   * skip the target's own sockets, while every remaining member still gets it.
   * Ordering: the eviction signal (`group:removed`) is emitted BEFORE the
   * system line, so the window a stale socket could still catch it is minimal
   * even before the envelope exclusion kicks in.
   */
  function rawEnvelopes(): Array<{
    channel: string;
    event: string;
    excludeUserId?: string;
    data: any;
  }> {
    return mocks.redis.publish.mock.calls.map(
      ([channel, raw]: [string, string]) => ({
        channel,
        ...(JSON.parse(raw) as {
          event: string;
          excludeUserId?: string;
          data: any;
        }),
      })
    );
  }

  beforeEach(() => {
    mocks.groupMemberRepo.updateStatus.mockResolvedValue({
      userId: TARGET,
      status: "KICKED",
    });
    // Let the SYSTEM message actually persist + publish so the exclusion on the
    // `message:new` room broadcast is observable (best-effort no-op otherwise).
    mocks.groupRoomRepo.allocateSequence.mockResolvedValue(7);
    mocks.groupMessageRepo.create.mockResolvedValue({
      id: "sysmsg-ban-1",
      roomId: ROOM,
      messageType: "SYSTEM",
      content: { text: "banned" },
      createdAt: new Date(),
    });
  });

  const ban = () =>
    new GroupMemberService(
      mocks.groupMemberRepo,
      mocks.groupRoomRepo,
      new GroupSystemMessageService(
        mocks.groupMessageRepo,
        mocks.groupRoomRepo,
        mocks.groupMemberRepo,
        mocks.cacheRepo,
        new UserSnapshotService(),
        mocks.redis
      ),
      mocks.redis
    ).kick({
      roomId: ROOM,
      targetUserId: TARGET,
      kickedBy: "bo-admin-1",
      asPlatformAdmin: true,
    });

  it("SECURITY: the banned target is excluded from both room broadcasts", async () => {
    await ban();

    const envelopes = rawEnvelopes();

    // Roster removal on the room channel excludes the target.
    const roster = envelopes.find(
      (p) => p.event === "group:member:removed" && p.channel === `conv:${ROOM}`
    )!;
    expect(roster.excludeUserId).toBe(TARGET);

    // The MEMBER_REMOVED system line on the room channel excludes the target.
    const sysLine = envelopes.find(
      (p) => p.event === "message:new" && p.channel === `conv:${ROOM}`
    )!;
    expect(sysLine.excludeUserId).toBe(TARGET);
    expect(sysLine.data.systemEvent).toBe("MEMBER_REMOVED");

    // The target still gets their own eviction signal.
    expect(channelsFor("group:removed")).toEqual([`user:${TARGET}`]);
  });

  it("the removed member gets the line once, on their own channel", async () => {
    await ban();

    const own = rawEnvelopes().filter(
      (p) => p.event === "message:new" && p.channel === `user:${TARGET}`
    );
    expect(own).toHaveLength(1);
    expect(own[0].excludeUserId).toBeUndefined();
    expect(own[0].data.systemEvent).toBe("MEMBER_REMOVED");
    expect(own[0].data.systemData).toMatchObject({ targetUserId: TARGET, source: "BO" });
  });

  it("ORDERING: the removal line reaches everyone (target included) before group:removed", async () => {
    await ban();

    const events = rawEnvelopes().map((p) => `${p.event}@${p.channel}`);
    const evictIdx = events.indexOf(`group:removed@user:${TARGET}`);
    expect(evictIdx).toBeGreaterThan(events.indexOf(`message:new@conv:${ROOM}`));
    expect(evictIdx).toBeGreaterThan(events.indexOf(`message:new@user:${TARGET}`));
    expect(events.indexOf(`message:new@user:${TARGET}`)).toBeGreaterThanOrEqual(0);
  });

  it("the removal line is created before kickedAt — inside the removed member's read boundary", async () => {
    await ban();

    const lineAt = mocks.groupMessageRepo.create.mock.invocationCallOrder[0];
    const statusAt = mocks.groupMemberRepo.updateStatus.mock.invocationCallOrder[0];
    expect(lineAt).toBeLessThan(statusAt);
  });
});
