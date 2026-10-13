/**
 * Contract §8: a community Moderator may ban/unban plain MEMBERS — never the
 * Admin or another Moderator (same outrank rule as mute/remove). The line,
 * push and audit row name the actor with role MODERATOR.
 */
import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import {
  publishCommunityMemberBannedSafe,
  publishCommunityMemberUnbannedSafe,
} from "../../src/messaging/publish-community.js";
import { publishCommunitySystemMessageForChatSafe } from "../../src/messaging/publish-community-chat.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CID = "c".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111";
const MOD = "22222222-2222-4222-8222-222222222222";
const MOD2 = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const TARGET = "99999999-9999-4999-8999-999999999999";

const row = (userId: string, role: string, status = "ACTIVE") => ({
  userId,
  communityId: CID,
  role,
  status,
  joinedAt: new Date(),
  snapshotUsername: userId,
  snapshotDisplayName: userId,
  snapshotAvatarKey: null,
});
const rows: Record<string, ReturnType<typeof row>> = {
  [ADMIN]: row(ADMIN, "ADMIN"),
  [MOD]: row(MOD, "MODERATOR"),
  [MOD2]: row(MOD2, "MODERATOR"),
  [MEMBER]: row(MEMBER, "MEMBER"),
  [TARGET]: row(TARGET, "MEMBER"),
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue({
    id: CID,
    name: "Cool",
    handle: "cool",
    avatarUrl: null,
    type: "PUBLIC",
    adminId: ADMIN,
    moderationStatus: "ACTIVE",
  });
  repo.findMembership.mockImplementation(async (_c: string, uid: string) => rows[uid] ?? null);
  repo.findMemberByUserId.mockImplementation(async (_c: string, uid: string) => rows[uid] ?? null);
  repo.findMembersByUserIds.mockImplementation(async (_c: string, ids: string[]) =>
    ids.map((id) => rows[id]).filter(Boolean)
  );
  repo.updateMemberStatus.mockImplementation(async (_c: string, uid: string, status: string) => ({
    ...rows[uid],
    status,
  }));
  repo.countActiveMembers.mockResolvedValue(3);
  repo.setMemberCount.mockResolvedValue(undefined);
  repo.createAuditLog.mockResolvedValue(undefined);
});

describe("Moderator ban", () => {
  it("POSITIVE: a moderator bans a plain member — line, push and audit carry MODERATOR", async () => {
    await communityService.banMember(CID, MOD, TARGET, "spam");

    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      CID,
      TARGET,
      "BANNED",
      expect.objectContaining({ bannedBy: MOD }),
      "MEMBER",
      undefined
    );
    expect(publishCommunitySystemMessageForChatSafe).toHaveBeenCalledWith(
      expect.objectContaining({ systemMessageType: "MEMBER_BANNED", triggeredByUserId: MOD })
    );
    const line = (publishCommunitySystemMessageForChatSafe as jest.Mock).mock.calls.find(
      (c) => c[0].systemMessageType === "MEMBER_BANNED"
    )![0];
    expect(line.metadata.actorRole).toBe("MODERATOR");
    expect(publishCommunityMemberBannedSafe).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: MOD, targetUserId: TARGET, actorRole: "MODERATOR" })
    );
    expect(repo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_BANNED", actorId: MOD, targetUserId: TARGET, actorRole: "MODERATOR" })
    );
  });

  it("NEGATIVE: a moderator cannot ban another moderator", async () => {
    await expect(communityService.banMember(CID, MOD, MOD2)).rejects.toMatchObject({
      message: "COMMUNITY_FORBIDDEN",
    });
    expect(repo.updateMemberStatus).not.toHaveBeenCalled();
  });

  it("NEGATIVE: a moderator cannot ban the admin", async () => {
    await expect(communityService.banMember(CID, MOD, ADMIN)).rejects.toMatchObject({
      message: "COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN",
    });
  });

  it("NEGATIVE: a plain member cannot ban", async () => {
    await expect(communityService.banMember(CID, MEMBER, TARGET)).rejects.toThrow();
    expect(repo.updateMemberStatus).not.toHaveBeenCalled();
  });

  it("POSITIVE: the admin still bans a moderator", async () => {
    await communityService.banMember(CID, ADMIN, MOD2);
    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      CID,
      MOD2,
      "BANNED",
      expect.anything(),
      "MEMBER",
      undefined
    );
  });
});

describe("Moderator unban", () => {
  beforeEach(() => {
    rows[TARGET] = row(TARGET, "MEMBER", "BANNED");
  });
  afterEach(() => {
    rows[TARGET] = row(TARGET, "MEMBER");
  });

  it("POSITIVE: a moderator lifts a member's ban; push and line carry MODERATOR", async () => {
    await communityService.unbanMember(CID, MOD, TARGET);
    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      CID,
      TARGET,
      "LEFT",
      expect.anything(),
      undefined,
      undefined,
      true,
      expect.any(Date)
    );
    expect(publishCommunityMemberUnbannedSafe).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: MOD, actorRole: "MODERATOR" })
    );
    const line = (publishCommunitySystemMessageForChatSafe as jest.Mock).mock.calls.find(
      (c) => c[0].systemMessageType === "MEMBER_UNBANNED"
    )![0];
    expect(line.metadata.actorRole).toBe("MODERATOR");
  });

  it("NEGATIVE: a plain member cannot unban", async () => {
    await expect(communityService.unbanMember(CID, MEMBER, TARGET)).rejects.toThrow();
    expect(repo.updateMemberStatus).not.toHaveBeenCalled();
  });
});
