/**
 * AIMESS-23: promoting a muted member to staff lifts the mute in the same flow.
 */
import { publishChatUserEvent } from "@aimess/redis";

import { communityRepository } from "../../src/repositories/community.repository.js";
import { communityService } from "../../src/services/community.service.js";
import { publishCommunityMemberMuteSyncedForChatSafe } from "../../src/messaging/publish-community-chat.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const userEvent = publishChatUserEvent as jest.Mock;
const chatMirror = publishCommunityMemberMuteSyncedForChatSafe as jest.Mock;

const CID = "a".repeat(24);
const CALLER = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

const member = (role: string) => ({
  userId: TARGET,
  status: "ACTIVE",
  role,
  joinedAt: new Date(),
  snapshotUsername: "target",
  snapshotDisplayName: "Target User",
  snapshotAvatarKey: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue({
    id: CID,
    status: "ACTIVE",
    adminId: CALLER,
    category: { id: "c", name: "General" },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  repo.findMembership.mockResolvedValue({ status: "ACTIVE", role: "ADMIN" });
  repo.findMemberByUserId.mockResolvedValue(member("MEMBER"));
  repo.updateMemberRole.mockResolvedValue(member("MODERATOR"));
  repo.deleteMemberMute.mockResolvedValue(undefined);
});

const unmutedTo = () =>
  userEvent.mock.calls.filter((c) => c[2] === "community:member:unmuted").map((c) => c[1]);

describe("updateMemberRole lifts an active mute on promotion", () => {
  it("unmutes a muted member promoted to moderator and syncs every channel", async () => {
    repo.findMemberMute.mockResolvedValue({ mutedUntil: new Date(Date.now() + 60_000) });

    await communityService.updateMemberRole(CID, CALLER, TARGET, "MODERATOR" as never);

    expect(repo.deleteMemberMute).toHaveBeenCalledWith(CID, TARGET);
    expect(unmutedTo()).toEqual([TARGET]);
    expect(chatMirror).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: CID, userId: TARGET, isMuted: false })
    );
  });

  it("an indefinite mute is lifted too", async () => {
    repo.findMemberMute.mockResolvedValue({ mutedUntil: null });

    await communityService.updateMemberRole(CID, CALLER, TARGET, "MODERATOR" as never);

    expect(repo.deleteMemberMute).toHaveBeenCalledWith(CID, TARGET);
  });

  it("leaves an unmuted or already-expired member's promotion unchanged", async () => {
    repo.findMemberMute.mockResolvedValueOnce(null);
    await communityService.updateMemberRole(CID, CALLER, TARGET, "MODERATOR" as never);

    repo.findMemberMute.mockResolvedValueOnce({ mutedUntil: new Date(Date.now() - 1_000) });
    await communityService.updateMemberRole(CID, CALLER, TARGET, "MODERATOR" as never);

    expect(repo.deleteMemberMute).not.toHaveBeenCalled();
    expect(unmutedTo()).toEqual([]);
  });

  it("a demotion never touches mute state", async () => {
    repo.findMemberByUserId.mockResolvedValue(member("MODERATOR"));
    repo.updateMemberRole.mockResolvedValue(member("MEMBER"));

    await communityService.updateMemberRole(CID, CALLER, TARGET, "MEMBER" as never);

    expect(repo.findMemberMute).not.toHaveBeenCalled();
    expect(repo.deleteMemberMute).not.toHaveBeenCalled();
  });
});

describe("transferAdmin lifts the new admin's active mute", () => {
  beforeEach(() => {
    repo.handOverAdmin.mockResolvedValue(true);
  });

  it("unmutes a muted member made admin and syncs every channel", async () => {
    repo.findMemberMute.mockResolvedValue({ mutedUntil: new Date(Date.now() + 60_000) });

    await communityService.transferAdmin(CID, CALLER, TARGET);

    expect(repo.deleteMemberMute).toHaveBeenCalledWith(CID, TARGET);
    expect(unmutedTo()).toEqual([TARGET]);
    expect(chatMirror).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: CID, userId: TARGET, isMuted: false })
    );
  });

  it("an unmuted member's transfer leaves mute state alone", async () => {
    repo.findMemberMute.mockResolvedValue(null);

    await communityService.transferAdmin(CID, CALLER, TARGET);

    expect(repo.deleteMemberMute).not.toHaveBeenCalled();
    expect(unmutedTo()).toEqual([]);
  });
});

describe("a promoted target gets the moderation unmute line only", () => {
  it("emits one MEMBER_UNMUTED line, not a duplicate personal copy", async () => {
    repo.handOverAdmin.mockResolvedValue(true);
    repo.findMemberMute.mockResolvedValue({ mutedUntil: null });
    const emit = jest.spyOn(communityService, "emitMemberSystemMessage");

    await communityService.transferAdmin(CID, CALLER, TARGET);

    const unmutedLines = emit.mock.calls.filter((c) => c[0].systemMessageType === "MEMBER_UNMUTED");
    expect(unmutedLines).toHaveLength(1);
    expect(unmutedLines[0][0].visibleToUserId).toBeUndefined();
    emit.mockRestore();
  });
});
