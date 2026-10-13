/**
 * Groups are leader + members only. Until the data migration has run, a stale
 * MODERATOR / BANNED / moderation-muted row must carry no privilege, block no
 * one and never reach a client as such.
 */
import request from "supertest";

import { buildGroupSystemFallbackText } from "@aimess/constants";

import {
  GroupMemberRepository,
  normalizeGroupMember,
} from "../../src/repositories/group-member.repository.js";
import { AdminGroupService } from "../../src/services/admin-group.service.js";
import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const ROOM = "grp_stale_mod";
const STALE = {
  roomId: ROOM,
  userId: "u-stale",
  role: "MODERATOR",
  status: "ACTIVE",
  moderationMuted: true,
  moderationMutedUntil: new Date(Date.now() + 60_000),
  moderationMutedBy: "lead",
};

describe("normalizeGroupMember", () => {
  it("MODERATOR → MEMBER, BANNED → KICKED, moderation mute cleared", () => {
    expect(normalizeGroupMember({ ...STALE, status: "BANNED" })).toMatchObject({
      role: "MEMBER",
      status: "KICKED",
      moderationMuted: false,
      moderationMutedUntil: null,
      moderationMutedBy: null,
    });
  });

  it("leaves a clean row (and null) untouched", () => {
    const clean = { role: "ADMIN", status: "ACTIVE", moderationMuted: false };
    expect(normalizeGroupMember(clean)).toBe(clean);
    expect(normalizeGroupMember(null)).toBeNull();
  });
});

describe("GroupMemberRepository normalizes every member read", () => {
  function repoWith(row: Record<string, unknown>) {
    const groupMember = {
      findUnique: jest.fn().mockResolvedValue(row),
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn().mockResolvedValue(row),
      upsert: jest.fn().mockResolvedValue(row),
    };
    const groupClosureMember = {
      findMany: jest.fn().mockResolvedValue([row]),
      count: jest.fn().mockResolvedValue(1),
    };
    return {
      repo: new GroupMemberRepository({ groupMember, groupClosureMember } as never),
      groupMember,
      groupClosureMember,
    };
  }

  it("single-row reads, roster, inbox, writes", async () => {
    const { repo } = repoWith(STALE);
    for (const row of [
      await repo.findActiveByRoomAndUser(ROOM, "u-stale"),
      await repo.findByRoomAndUser(ROOM, "u-stale"),
      (await repo.findActiveMembers(ROOM))[0],
      (await repo.getActiveMemberships("u-stale"))[0],
      (await repo.getInboxMemberships("u-stale"))[0],
      await repo.updateStatus(ROOM, "u-stale", "ACTIVE"),
      await repo.upsert(ROOM, "u-stale", {}),
    ]) {
      expect(row).toMatchObject({ role: "MEMBER", moderationMuted: false });
    }
  });

  it("a stale BANNED row reads as KICKED", async () => {
    const { repo } = repoWith({ ...STALE, status: "BANNED" });
    await expect(repo.findByRoomAndUser(ROOM, "u-stale")).resolves.toMatchObject({
      status: "KICKED",
    });
  });

  it("admin roster: ACTIVE by default, MEMBER/BANNED filters match the stale spellings, rows normalized", async () => {
    const { repo, groupMember } = repoWith(STALE);
    const base = { roomId: ROOM, skip: 0, take: 20 };

    const { rows } = await repo.adminListMembers(base);
    expect(rows[0].role).toBe("MEMBER");
    expect(groupMember.findMany.mock.calls[0][0].where.AND).toContainEqual({
      status: "ACTIVE",
    });

    await repo.adminListMembers({ ...base, role: "MEMBER", status: "BANNED" });
    expect(groupMember.findMany.mock.calls[1][0].where.AND).toEqual(
      expect.arrayContaining([
        { role: { in: ["MEMBER", "MODERATOR"] } },
        { status: { in: ["KICKED", "BANNED"] } },
      ])
    );
  });

  it("closure snapshot rows are normalized too", async () => {
    const { repo, groupClosureMember } = repoWith({ ...STALE, status: "BANNED" });

    const { rows } = await repo.adminListClosureMembers({
      roomId: ROOM,
      role: "MEMBER",
      skip: 0,
      take: 20,
    });

    expect(rows[0]).toMatchObject({ role: "MEMBER", status: "KICKED" });
    expect(groupClosureMember.findMany.mock.calls[0][0].where.role).toEqual({
      in: ["MEMBER", "MODERATOR"],
    });
  });

  it("the admin roster count is ACTIVE only (no BANNED rows)", async () => {
    const { repo, groupMember } = repoWith(STALE);
    await repo.countRosterMembers(ROOM);
    expect(groupMember.count).toHaveBeenCalledWith({
      where: { roomId: ROOM, status: "ACTIVE" },
    });
  });
});

describe("a stale MODERATOR has no group privileges", () => {
  let app: import("express").Express;
  let mocks: BuiltMocks;

  beforeEach(() => {
    ({ app, mocks } = buildApp());
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      settings: { allowMemberInviteLink: false },
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MODERATOR",
      status: "ACTIVE",
    });
  });

  it("cannot pin", async () => {
    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/messages/g1/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
    expect(mocks.groupMessagePinRepo.createPin).not.toHaveBeenCalled();
  });

  it("cannot change group settings", async () => {
    const res = await request(app)
      .patch(`/api/chat/groups/rooms/${ROOM}`)
      .set(bearer(makeAccessToken()))
      .send({ name: "Mine now" });

    expect(res.status).toBe(400);
    expect(mocks.groupRoomRepo.updateRoom).not.toHaveBeenCalled();
  });

  it("cannot create an invite link when members may not", async () => {
    const res = await request(app)
      .post("/api/chat/invite-links")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM });

    expect(res.status).toBe(400);
    expect(mocks.groupInviteLinkRepo.create).not.toHaveBeenCalled();
  });

  it("cannot hand over leadership (assign roles)", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/role")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: "someone-else", role: "ADMIN" });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.transferLeadership).not.toHaveBeenCalled();
  });

  it("a leftover moderation mute no longer blocks the leader (pin succeeds)", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
      status: "ACTIVE",
      moderationMuted: true,
      moderationMutedUntil: null,
    });
    mocks.groupMessagePinRepo.countPinsByRoom.mockResolvedValue(0);
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "g1",
      roomId: ROOM,
      senderId: "u",
      content: { text: "pin" },
      createdAt: new Date(1),
    });
    mocks.groupMessagePinRepo.createPin.mockResolvedValue({
      id: "pin1",
      pinnedAt: new Date(2),
    });
    mocks.groupRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 1 });

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/messages/g1/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(201);
  });
});

describe("Backoffice per-group ban is a removal", () => {
  function makeService(member: { role: string } | null, status = "ACTIVE") {
    const groupRoomRepo = {
      adminFindByRoomId: jest.fn().mockResolvedValue({ roomId: ROOM, status }),
    };
    const groupMemberRepo = {
      findActiveByRoomAndUser: jest.fn().mockResolvedValue(member),
      updateStatus: jest.fn(),
    };
    const groupMemberService = {
      kick: jest.fn().mockResolvedValue({}),
      autoSucceed: jest.fn().mockResolvedValue(true),
    };
    const service = new AdminGroupService(
      groupRoomRepo as never,
      groupMemberRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      groupMemberService as never
    );
    return { service, groupMemberRepo, groupMemberService };
  }
  const BAN = { groupId: ROOM, userId: "binh", actorAdminId: "bo-1", reason: "spam" };

  it("removes (KICKED, PLATFORM actor) instead of writing a BANNED row; shape kept", async () => {
    const { service, groupMemberRepo, groupMemberService } = makeService({
      role: "MEMBER",
    });

    await expect(service.banGroupMember(BAN)).resolves.toEqual({
      ok: true,
      found: true,
      errorCode: "",
      closedGroup: false,
    });
    expect(groupMemberService.kick).toHaveBeenCalledWith({
      roomId: ROOM,
      targetUserId: "binh",
      kickedBy: "bo-1",
      reason: "spam",
      asPlatformAdmin: true,
    });
    expect(groupMemberRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("the leader hands over first, then is removed", async () => {
    const { service, groupMemberService } = makeService({ role: "ADMIN" });

    await service.banGroupMember(BAN);

    expect(groupMemberService.autoSucceed).toHaveBeenCalledWith(ROOM, "binh");
    expect(groupMemberService.kick).toHaveBeenCalled();
  });

  it("not a member / closed group keep their error codes", async () => {
    await expect(makeService(null).service.banGroupMember(BAN)).resolves.toMatchObject({
      ok: false,
      errorCode: "CHAT_NOT_A_MEMBER",
    });
    await expect(
      makeService({ role: "MEMBER" }, "CLOSED").service.banGroupMember(BAN)
    ).resolves.toMatchObject({ ok: false, errorCode: "CHAT_GROUP_NOT_ACTIVE" });
  });

  it("unban is a no-op success", async () => {
    const { service, groupMemberRepo, groupMemberService } = makeService(null);

    await expect(
      service.unbanGroupMember({ groupId: ROOM, userId: "binh", actorAdminId: "bo-1" })
    ).resolves.toEqual({ ok: true, found: true, errorCode: "" });
    expect(groupMemberRepo.updateStatus).not.toHaveBeenCalled();
    expect(groupMemberService.kick).not.toHaveBeenCalled();
  });

  it('the line reads "AI Mess Administrator removed Binh"', () => {
    expect(
      buildGroupSystemFallbackText(
        "MEMBER_REMOVED",
        { targetUserId: "binh", targetName: "Binh", source: "BO" },
        "bystander"
      )
    ).toBe("AI Mess Administrator removed Binh");
  });
});
