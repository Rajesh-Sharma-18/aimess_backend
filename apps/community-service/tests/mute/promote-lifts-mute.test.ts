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
  repo.findById.mockResolvedValue({ id: CID, status: "ACTIVE", adminId: CALLER });
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
