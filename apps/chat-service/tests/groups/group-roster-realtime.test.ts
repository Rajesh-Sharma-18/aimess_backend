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
