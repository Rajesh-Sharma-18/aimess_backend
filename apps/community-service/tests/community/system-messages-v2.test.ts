/**
 * System Messages v2 (§4) — community-service: audit log (ADMIN-only, snapshot
 * shape), closed-community visibility, admin handover (ban / suspend / purge /
 * inactivity) and the CONNECTION_LOST stream end mapping.
 */
jest.mock("../../src/config/prisma.js", () => ({
  prisma: { communityMember: { updateMany: jest.fn(async () => ({ count: 0 })) } },
}));

import { communityRepository } from "../../src/repositories/community.repository.js";
import { communityService } from "../../src/services/community.service.js";
import {
  publishCommunityAdminInactiveReminderSafe,
  publishCommunityAdminTransferredSafe,
} from "../../src/messaging/publish-community.js";
import { publishCommunitySystemMessageForChatSafe } from "../../src/messaging/publish-community-chat.js";
import { handleUserPurged } from "../../src/handlers/user-purged.handler.js";
import { streamEndedReason } from "../../src/consumers/stream-lifecycle.consumer.js";
import { redis } from "../../src/config/redis.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const sysMsg = publishCommunitySystemMessageForChatSafe as jest.Mock;
const transferred = publishCommunityAdminTransferredSafe as jest.Mock;
const reminder = publishCommunityAdminInactiveReminderSafe as jest.Mock;

const CID = "c".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111";
const MOD = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400_000;

function community(overrides: Record<string, unknown> = {}) {
  return {
    id: CID,
    name: "Backend Devs",
    handle: "backend_devs",
    description: null,
    type: "PUBLIC",
    category: { id: "cat1", name: "Tech" },
    creatorId: ADMIN,
    adminId: ADMIN,
    memberCount: 3,
    avatarUrl: null,
    coverUrl: null,
    moderationStatus: "ACTIVE",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  repo.handOverAdmin.mockResolvedValue(true);
  repo.findOldestActiveModerator.mockResolvedValue(null);
  repo.findOldestActiveMember.mockResolvedValue(null);
  repo.findMembersByUserIds.mockResolvedValue([]);
});

describe("audit log — ADMIN only, snapshot shape", () => {
  it("moderators get 403 COMMUNITY_INSUFFICIENT_PERMISSIONS", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findMembership.mockResolvedValue({ role: "MODERATOR", status: "ACTIVE" });

    await expect(
      communityService.listAuditLogs(CID, MOD, { page: 1, limit: 20 })
    ).rejects.toMatchObject({
      statusCode: 403,
      messageKey: "COMMUNITY_INSUFFICIENT_PERMISSIONS",
    });
    expect(repo.listAuditLogs).not.toHaveBeenCalled();
  });

  it("admin gets {id, action, createdAt ms, actor, target, reason?, metadata}; legacy rows resolve live in ONE batch", async () => {
    const at = new Date("2026-10-01T00:00:00.000Z");
    repo.findById.mockResolvedValue(community());
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.listAuditLogs.mockResolvedValue({
      total: 3,
      rows: [
        {
          id: "a1",
          actorId: MOD,
          action: "MEMBER_MUTED",
          targetUserId: MEMBER,
          actorName: "Lan",
          actorRole: "MODERATOR",
          targetName: "Binh",
          reason: "spam",
          metadata: { durationMinutes: 60 },
          createdAt: at,
        },
        {
          id: "a2",
          actorId: ADMIN,
          action: "MEMBER_KICKED",
          targetUserId: MEMBER,
          actorName: null,
          actorRole: null,
          targetName: null,
          reason: null,
          metadata: null,
          createdAt: at,
        },
        {
          id: "a3",
          actorId: "platform_admin",
          action: "MEMBER_BANNED",
          targetUserId: null,
          actorName: null,
          actorRole: "PLATFORM",
          targetName: null,
          reason: null,
          metadata: null,
          createdAt: at,
        },
      ],
    });
    repo.findMembersByUserIds.mockResolvedValue([
      { userId: ADMIN, role: "ADMIN", snapshotDisplayName: "Minh", snapshotUsername: "minh" },
      { userId: MEMBER, role: "MEMBER", snapshotDisplayName: "", snapshotUsername: "binh" },
    ]);

    const page = await communityService.listAuditLogs(CID, ADMIN, {
      page: 1,
      limit: 20,
    });

    expect(repo.findMembersByUserIds).toHaveBeenCalledTimes(1);
    expect(page.data[0]).toEqual({
      id: "a1",
      action: "MEMBER_MUTED",
      createdAt: at.getTime(),
      actor: { id: MOD, name: "Lan", role: "MODERATOR" },
      target: { id: MEMBER, name: "Binh" },
      reason: "spam",
      metadata: { durationMinutes: 60 },
    });
    expect(page.data[1]).toMatchObject({
      actor: { id: ADMIN, name: "Minh", role: "ADMIN" },
      target: { id: MEMBER, name: "binh" },
    });
    expect(page.data[1]).not.toHaveProperty("reason");
    expect(page.data[2]).toMatchObject({
      actor: { name: "AI Mess Administrator", role: "PLATFORM" },
      target: null,
    });
  });

  it("recordAudit snapshots actor/target name + role at write time", async () => {
    repo.findMembersByUserIds.mockResolvedValue([
      { userId: MOD, role: "MODERATOR", snapshotDisplayName: "Lan", snapshotUsername: "lan" },
      { userId: MEMBER, role: "MEMBER", snapshotDisplayName: "Binh", snapshotUsername: "binh" },
    ]);

    await communityService.recordAudit({
      communityId: CID,
      actorId: MOD,
      action: "MEMBER_MUTED",
      targetUserId: MEMBER,
    });

    expect(repo.createAuditLog).toHaveBeenCalledWith({
      communityId: CID,
      actorId: MOD,
      action: "MEMBER_MUTED",
      targetUserId: MEMBER,
      actorName: "Lan",
      actorRole: "MODERATOR",
      targetName: "Binh",
    });
  });
});

describe("closed community — hidden from members, visible to its admin", () => {
  it.each([
    ["owner-closed", { status: "CLOSED" }],
    ["platform-suspended", { moderationStatus: "SUSPENDED" }],
  ])("%s: a member open is 403 COMMUNITY_IS_CLOSED", async (_l, patch) => {
    repo.findById.mockResolvedValue(community(patch));
    repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });

    await expect(communityService.getById(CID, MEMBER)).rejects.toMatchObject({
      statusCode: 403,
      messageKey: "COMMUNITY_IS_CLOSED",
    });
    await expect(
      communityService.listMembers(CID, MEMBER, { page: 1, limit: 20 })
    ).rejects.toMatchObject({ messageKey: "COMMUNITY_IS_CLOSED" });
  });

  it("the admin still opens it (read-only, with Reopen)", async () => {
    repo.findById.mockResolvedValue(community({ status: "CLOSED" }));
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });

    const data = await communityService.getById(CID, ADMIN);
    expect(data.id).toBe(CID);
    expect(data.role).toBe("ADMIN");
  });
});

describe("admin handover — successor order and causes", () => {
  it("prefers the longest-serving MODERATOR; former admin → MODERATOR; auto line names nobody", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findOldestActiveModerator.mockResolvedValue({
      userId: MOD,
      snapshotDisplayName: "Hung",
      snapshotUsername: "hung",
    });
    repo.findOldestActiveMember.mockResolvedValue({
      userId: MEMBER,
      snapshotDisplayName: "Binh",
      snapshotUsername: "binh",
    });

    const ok = await communityService.autoHandOverAdmin(CID, ADMIN, "ADMIN_BANNED");

    expect(ok).toBe(true);
    expect(repo.handOverAdmin).toHaveBeenCalledWith(CID, ADMIN, MOD, false);
    expect(repo.findOldestActiveMember).not.toHaveBeenCalled();
    expect(transferred).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ADMIN,
        targetUserId: MOD,
        reason: "ADMIN_BANNED",
        auto: true,
        formerAdminRole: "MODERATOR",
        communityName: "Backend Devs",
      })
    );
    const line = sysMsg.mock.calls[0][0];
    expect(line).toMatchObject({
      systemMessageType: "ROLE_CHANGED",
      metadata: {
        actorUserId: null,
        auto: true,
        targetUserId: MOD,
        targetName: "Hung",
        newRole: "ADMIN",
        oldRole: "MODERATOR",
        formerAdminUserId: ADMIN,
        formerAdminNewRole: "MODERATOR",
      },
    });
    expect(line.metadata).not.toHaveProperty("actorRole");
  });

  it("falls back to the longest-standing MEMBER when there is no moderator", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findOldestActiveMember.mockResolvedValue({
      userId: MEMBER,
      snapshotDisplayName: "Binh",
      snapshotUsername: "binh",
    });

    await communityService.autoHandOverAdmin(CID, ADMIN, "ADMIN_BANNED");

    expect(repo.findOldestActiveMember).toHaveBeenCalledWith(CID, [ADMIN]);
    expect(repo.handOverAdmin).toHaveBeenCalledWith(CID, ADMIN, MEMBER, false);
  });

  it("skips suspended / banned successors and tries the next one", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findOldestActiveModerator.mockImplementation(async (_c: string, skip: string[]) =>
      skip.includes(MOD) ? null : { userId: MOD, snapshotDisplayName: "", snapshotUsername: "" }
    );
    repo.findOldestActiveMember.mockResolvedValue({
      userId: MEMBER,
      snapshotDisplayName: "Binh",
      snapshotUsername: "binh",
    });
    (redis.get as jest.Mock).mockImplementation(async (key: string) =>
      key === `aimess:user:suspended:${MOD}` ? String(Date.now() + DAY) : null
    );

    await communityService.autoHandOverAdmin(CID, ADMIN, "ADMIN_BANNED");

    expect(repo.findOldestActiveMember).toHaveBeenCalledWith(CID, [ADMIN, MOD]);
    expect(repo.handOverAdmin).toHaveBeenCalledWith(CID, ADMIN, MEMBER, false);
    (redis.get as jest.Mock).mockResolvedValue(null);
  });

  it("deleted admin: hands over and ends their membership (LEFT, not MODERATOR)", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findOldestActiveMember.mockResolvedValue({
      userId: MEMBER,
      snapshotDisplayName: "Binh",
      snapshotUsername: "binh",
    });
    const removal = jest
      .spyOn(communityService, "announceMemberRemoval")
      .mockResolvedValue(2);

    await communityService.autoHandOverAdmin(CID, ADMIN, "ADMIN_DELETED");

    expect(repo.handOverAdmin).toHaveBeenCalledWith(CID, ADMIN, MEMBER, true);
    expect(removal).toHaveBeenCalledWith(CID, ADMIN, "LEFT", expect.anything());
    removal.mockRestore();
  });

  it("is a no-op when the seat already moved (idempotent / lost race)", async () => {
    repo.findById.mockResolvedValue(community({ adminId: MOD }));
    expect(
      await communityService.autoHandOverAdmin(CID, ADMIN, "ADMIN_INACTIVE")
    ).toBe(false);
    expect(repo.handOverAdmin).not.toHaveBeenCalled();

    repo.findById.mockResolvedValue(community());
    repo.findOldestActiveModerator.mockResolvedValue({ userId: MOD, snapshotDisplayName: "", snapshotUsername: "" });
    repo.handOverAdmin.mockResolvedValue(false);
    expect(
      await communityService.autoHandOverAdmin(CID, ADMIN, "ADMIN_INACTIVE")
    ).toBe(false);
    expect(transferred).not.toHaveBeenCalled();
  });

  it("platform suspension hands over instead of closing", async () => {
    repo.findCommunityIdsByAdminId.mockResolvedValue([CID]);
    repo.findById.mockResolvedValue(community());
    repo.findOldestActiveModerator.mockResolvedValue({ userId: MOD, snapshotDisplayName: "Hung", snapshotUsername: "hung" });
    const close = jest.spyOn(communityService, "closeCommunityForSystemBan");

    const res = await communityService.adminApplySystemBan(ADMIN, "bo-admin", null, "ADMIN_SUSPENDED");

    expect(res.closedCommunityIds).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    expect(transferred).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ADMIN_SUSPENDED" })
    );
    close.mockRestore();
  });

  it("nobody left → the existing close, stamped with the cause", async () => {
    repo.findCommunityIdsByAdminId.mockResolvedValue([CID]);
    repo.findById.mockResolvedValue(community({ memberCount: 1 }));
    const close = jest
      .spyOn(communityService, "closeCommunityForSystemBan")
      .mockResolvedValue(true);

    const res = await communityService.adminApplySystemBan(ADMIN, "bo-admin", "spam");

    expect(close).toHaveBeenCalledWith(CID, ADMIN, "bo-admin", "spam", "ADMIN_BANNED");
    expect(res.closedCommunityIds).toEqual([CID]);
    close.mockRestore();
  });

  it("account deletion (user.purged) runs the same handover entry point", async () => {
    const apply = jest
      .spyOn(communityService, "adminApplySystemBan")
      .mockResolvedValue({ closedCommunityIds: [], removedCommunityIds: [] });
    await handleUserPurged({ userId: ADMIN } as never);

    expect(apply).toHaveBeenCalledWith(ADMIN, "system", null, "ADMIN_DELETED");
    apply.mockRestore();
  });
});

describe("admin inactivity sweep — day 20 / 27 / 30, idempotent", () => {
  const NOW = new Date("2026-10-30T00:00:00.000Z");
  const idle = (days: number, stage?: number) => ({
    id: `m${days}`,
    communityId: CID,
    userId: ADMIN,
    lastActiveAt: new Date(NOW.getTime() - days * DAY),
    adminInactiveStage: stage ?? null,
  });

  beforeEach(() => {
    repo.findManyByIds.mockResolvedValue([community()]);
    repo.findCommunityIdsWithModerator.mockResolvedValue(new Set([CID]));
  });

  it.each([
    [20, 20, 10],
    [27, 27, 3],
  ])("day %i sends the stage-%i reminder (%i days left)", async (days, stage, daysLeft) => {
    repo.findIdleAdmins.mockResolvedValueOnce([idle(days)]);

    const res = await communityService.runAdminInactivitySweep(NOW);

    expect(repo.initMissingAdminActivity).toHaveBeenCalledWith(NOW);
    expect(repo.claimAdminInactiveStage).toHaveBeenCalledWith(`m${days}`, stage);
    expect(reminder).toHaveBeenCalledWith({
      communityId: CID,
      eventAt: NOW.toISOString(),
      communityName: "Backend Devs",
      adminId: ADMIN,
      daysLeft,
      successorKind: "MODERATOR",
    });
    expect(res).toEqual({ reminded: 1, handedOver: 0 });
  });

  it("a re-run with the stage already claimed sends nothing", async () => {
    repo.findIdleAdmins.mockResolvedValueOnce([idle(21, 20)]);
    repo.claimAdminInactiveStage.mockResolvedValueOnce(false);

    const res = await communityService.runAdminInactivitySweep(NOW);

    expect(reminder).not.toHaveBeenCalled();
    expect(res.reminded).toBe(0);
  });

  it("successorKind is MEMBER when there is no moderator", async () => {
    repo.findIdleAdmins.mockResolvedValueOnce([idle(20)]);
    repo.findCommunityIdsWithModerator.mockResolvedValue(new Set());

    await communityService.runAdminInactivitySweep(NOW);

    expect(reminder).toHaveBeenCalledWith(
      expect.objectContaining({ successorKind: "MEMBER" })
    );
  });

  it("day 30 hands over once; a second run finds the seat moved and does nothing", async () => {
    repo.findIdleAdmins.mockResolvedValueOnce([idle(30, 27)]);
    repo.findById.mockResolvedValueOnce(community());
    repo.findOldestActiveModerator.mockResolvedValue({ userId: MOD, snapshotDisplayName: "Hung", snapshotUsername: "hung" });

    const first = await communityService.runAdminInactivitySweep(NOW);
    expect(first).toEqual({ reminded: 0, handedOver: 1 });
    expect(transferred).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ADMIN_INACTIVE", auto: true })
    );

    // Former admin is MODERATOR now — the seat claim fails on any replay.
    transferred.mockClear();
    repo.findIdleAdmins.mockResolvedValueOnce([idle(30, 27)]);
    repo.findManyByIds.mockResolvedValue([community({ adminId: MOD })]);
    const second = await communityService.runAdminInactivitySweep(NOW);
    expect(second).toEqual({ reminded: 0, handedOver: 0 });
    expect(transferred).not.toHaveBeenCalled();
  });

  it("skips an admin who is alone, or a closed community", async () => {
    repo.findIdleAdmins.mockResolvedValueOnce([idle(30)]);
    repo.findManyByIds.mockResolvedValue([community({ memberCount: 1 })]);
    await communityService.runAdminInactivitySweep(NOW);

    repo.findIdleAdmins.mockResolvedValueOnce([idle(20)]);
    repo.findManyByIds.mockResolvedValue([community({ status: "CLOSED" })]);
    await communityService.runAdminInactivitySweep(NOW);

    expect(reminder).not.toHaveBeenCalled();
    expect(repo.handOverAdmin).not.toHaveBeenCalled();
  });
});

describe("livestream — connection loss", () => {
  it("maps the stream reason CONNECTION_LOST to endedReason CONNECTION_LOST", () => {
    expect(streamEndedReason("CONNECTION_LOST")).toBe("CONNECTION_LOST");
    expect(streamEndedReason("HOST_ENDED")).toBe("USER");
  });
});
