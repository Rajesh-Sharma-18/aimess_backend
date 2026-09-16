/**
 * Group list synchronization when a membership ends (leave / admin removal).
 *
 * The group chat used to stay in the ex-member's list read-only, WhatsApp-style
 * — `getInboxMemberships` fed the inbox ACTIVE + LEFT + KICKED rows, and
 * `assertGroupReadAccess` let those rows keep reading history. The product rule
 * is now the opposite: the instant a membership ends, the group leaves that
 * user's list and every read is refused, while the group itself and every
 * remaining member are untouched.
 *
 * A DISBANDED room is the one case that still reads past ACTIVE: a disband
 * marks every membership LEFT, and an open client has to keep rendering the
 * history it already has.
 */
import request from "supertest";

import { GroupMemberRepository } from "../../src/repositories/group-member.repository.js";
import { assertGroupReadAccess } from "../../src/lib/access-guard.js";
import { ForbiddenError } from "@aimess/errors";
import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const ROOM = "grp_membership_sync";
const TARGET = "target-user-1";
const BYSTANDER = "bystander-1";

let app: import("express").Express;
let mocks: BuiltMocks;

/** Every `redis.publish` call as `{ channel, event, data }`. */
function publishes(): Array<{ channel: string; event: string; data: any }> {
  return mocks.redis.publish.mock.calls.map(
    ([channel, raw]: [string, string]) => ({
      channel,
      ...(JSON.parse(raw) as { event: string; data: any }),
    })
  );
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
    { userId: TEST_USER_ID },
    { userId: BYSTANDER },
  ]);
  mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
    roomId: ROOM,
    name: "Testing Removal",
    status: "ACTIVE",
    memberCount: 2,
    memberLimit: 200,
  });
});

// ── 1. The list query ────────────────────────────────────────────────────────
describe("GroupMemberRepository.getInboxMemberships", () => {
  it("LIST: selects ACTIVE memberships only — a LEFT/KICKED row can never reach the inbox", async () => {
    let where: Record<string, unknown> | undefined;
    const prisma = {
      groupMember: {
        findMany: (args: { where: Record<string, unknown> }) => {
          where = args.where;
          return Promise.resolve([]);
        },
      },
    };
    await new GroupMemberRepository(prisma as never).getInboxMemberships("u1");

    expect(where).toEqual({ userId: "u1", status: "ACTIVE" });
  });
});

// ── 2. Direct API access after the membership ends ───────────────────────────
describe("assertGroupReadAccess after removal", () => {
  const findByRoomAndUser = jest.fn();
  const memberRepo = { findByRoomAndUser };
  const roomRepo = { findByRoomId: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    roomRepo.findByRoomId.mockResolvedValue({ roomId: ROOM, status: "ACTIVE" });
  });

  it("ACTIVE member keeps full read access", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "ACTIVE" });
    const result = await assertGroupReadAccess(
      memberRepo,
      ROOM,
      TARGET,
      roomRepo
    );
    expect(result.readCutoffBefore).toBeUndefined();
  });

  it("DENIES a member who left a live group", async () => {
    findByRoomAndUser.mockResolvedValue({ status: "LEFT", leftAt: new Date() });
    await expect(
      assertGroupReadAccess(memberRepo, ROOM, TARGET, roomRepo)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("DENIES a member an admin removed from a live group", async () => {
    findByRoomAndUser.mockResolvedValue({
      status: "KICKED",
      kickedAt: new Date(),
    });
    await expect(
      assertGroupReadAccess(memberRepo, ROOM, TARGET, roomRepo)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("REGRESSION: a DISBANDED room stays readable up to the disband instant", async () => {
    const leftAt = new Date("2026-03-03T00:00:00.000Z");
    findByRoomAndUser.mockResolvedValue({ status: "LEFT", leftAt });
    roomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      status: "DISBANDED",
      disbandedAt: leftAt,
    });
    const result = await assertGroupReadAccess(
      memberRepo,
      ROOM,
      TARGET,
      roomRepo
    );
    expect(result.readCutoffBefore).toEqual(leftAt);
  });
});

describe("GET /api/chat/groups/rooms/:roomId/messages after removal", () => {
  it("ACCESS: a kicked member can no longer fetch the group's messages", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      userId: TEST_USER_ID,
      status: "KICKED",
      kickedAt: new Date(),
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);
    mocks.groupRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      status: "ACTIVE",
    });

    const res = await request(app)
      .get(`/api/chat/groups/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });
});

// ── 3. Unread recalculation + realtime, on both removal paths ────────────────
describe("membership removal recalculates unread", () => {
  it("LEAVE: zeroes the leaver's unread counter and pushes a fresh summary", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      userId: TEST_USER_ID,
      role: "MEMBER",
      unreadCount: 7,
    });
    mocks.groupMemberRepo.updateStatus.mockResolvedValue({
      userId: TEST_USER_ID,
      status: "LEFT",
    });

    const res = await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.updateStatus).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      "LEFT",
      expect.objectContaining({ unreadCount: 0 })
    );
    const removed = publishes().filter((p) => p.event === "group:removed");
    expect(removed.map((p) => p.channel)).toEqual([`user:${TEST_USER_ID}`]);
    expect(removed[0]!.data).toMatchObject({ roomId: ROOM, reason: "LEAVE" });
  });

  it("KICK: zeroes the removed member's unread counter", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
      async (_roomId: string, userId: string) =>
        userId === TEST_USER_ID
          ? { userId: TEST_USER_ID, role: "ADMIN" }
          : { userId: TARGET, role: "MEMBER", unreadCount: 4 }
    );
    mocks.groupMemberRepo.updateStatus.mockResolvedValue({
      userId: TARGET,
      status: "KICKED",
    });

    const res = await request(app)
      .post("/api/chat/group-members/kick")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.updateStatus).toHaveBeenCalledWith(
      ROOM,
      TARGET,
      "KICKED",
      expect.objectContaining({ unreadCount: 0 })
    );
    const removed = publishes().filter((p) => p.event === "group:removed");
    expect(removed.map((p) => p.channel)).toEqual([`user:${TARGET}`]);
    expect(removed[0]!.data).toMatchObject({ roomId: ROOM, reason: "KICK" });
  });
});
