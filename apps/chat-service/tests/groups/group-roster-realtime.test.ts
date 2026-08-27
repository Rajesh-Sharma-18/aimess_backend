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
    // A ban must survive a re-invite — clearing it here would let any
    // ADMIN/MODERATOR launder a ban into a plain add, bypassing `unban()`.
    expect(mocks.groupMemberRepo.upsert.mock.calls[0][2]).not.toHaveProperty(
      "bannedAt"
    );
    // The re-added member's own channel is what un-sticks their client.
    expect(channelsFor("group:added")).toEqual([`user:${TARGET}`]);
  });

  it("RE-ADD: a BANNED row is lifted by an ADMIN's manual add — the ONE key to the block", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      userId: TARGET,
      status: "BANNED",
      bannedAt: new Date(),
      bannedBy: TEST_USER_ID,
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(201);
    // The ban is cleared in the SAME write that re-activates the row, so no
    // stale bannedAt survives to block the next read.
    expect(mocks.groupMemberRepo.upsert.mock.calls[0][2]).toMatchObject({
      status: "ACTIVE",
      bannedAt: null,
      bannedBy: null,
    });
  });

  it("RE-ADD: a MODERATOR cannot launder a ban into a plain add", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      userId: TEST_USER_ID,
      role: "MODERATOR",
      status: "ACTIVE",
    });
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      userId: TARGET,
      status: "BANNED",
      bannedAt: new Date(),
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
  it("REALTIME: group:member:updated carries the new role to the room and every member", async () => {
    mocks.groupMemberRepo.updateRole.mockResolvedValue({
      userId: TARGET,
      role: "MODERATOR",
    });

    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET, role: "MODERATOR" });

    expect(res.status).toBe(200);
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
      role: "MODERATOR",
      previousRole: "MEMBER",
      actorId: TEST_USER_ID,
    });
  });

  it("REALTIME: an admin hand-off (Make Admin) announces BOTH changed rows", async () => {
    mocks.groupMemberRepo.updateRole.mockResolvedValue({
      userId: TARGET,
      role: "ADMIN",
    });

    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET, role: "ADMIN" });

    expect(res.status).toBe(200);
    const updates = publishes().filter(
      (p) => p.event === "group:member:updated" && p.channel === `conv:${ROOM}`
    );
    expect(updates.map((u) => [u.data.memberId, u.data.role])).toEqual([
      [TARGET, "ADMIN"],
      [TEST_USER_ID, "MEMBER"],
    ]);
  });
});

describe("POST /api/chat/group-members/ban", () => {
  /**
   * The banned member must NEVER receive the room event/line announcing their
   * own ban. The room broadcast of both the roster event AND the MEMBER_BANNED
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
      status: "BANNED",
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

  it("route is wired and returns 200", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/ban")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });
    expect(res.status).toBe(200);
  });

  it("SECURITY: the banned target is excluded from both room broadcasts", async () => {
    await request(app)
      .post("/api/chat/group-members/ban")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    const envelopes = rawEnvelopes();

    // Roster removal on the room channel excludes the target.
    const roster = envelopes.find(
      (p) => p.event === "group:member:removed" && p.channel === `conv:${ROOM}`
    )!;
    expect(roster.excludeUserId).toBe(TARGET);

    // The MEMBER_BANNED system line on the room channel excludes the target.
    const sysLine = envelopes.find(
      (p) => p.event === "message:new" && p.channel === `conv:${ROOM}`
    )!;
    expect(sysLine.excludeUserId).toBe(TARGET);
    expect(sysLine.data.systemEvent).toBe("MEMBER_BANNED");

    // The target still gets their own eviction signal.
    expect(channelsFor("group:removed")).toEqual([`user:${TARGET}`]);
  });

  it("ORDERING: group:removed (eviction) is emitted before the ban system line", async () => {
    await request(app)
      .post("/api/chat/group-members/ban")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    const events = rawEnvelopes().map((p) => `${p.event}@${p.channel}`);
    const evictIdx = events.indexOf(`group:removed@user:${TARGET}`);
    const sysIdx = events.indexOf(`message:new@conv:${ROOM}`);
    expect(evictIdx).toBeGreaterThanOrEqual(0);
    expect(sysIdx).toBeGreaterThan(evictIdx);
  });
});
