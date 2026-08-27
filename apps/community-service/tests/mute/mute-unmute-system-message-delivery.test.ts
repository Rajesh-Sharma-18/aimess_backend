/**
 * communityService.muteMember / unmuteMember — PERSONAL system-message delivery.
 *
 * Regression coverage for a real end-to-end gap that pure unit tests of
 * CommunitySystemMessageService.post() (chat-service) could never catch: they
 * assert the chat-service formatter behaves correctly GIVEN a `visibleToUserId`,
 * but never exercise whether community-service's `muteMember` / `unmuteMember`
 * actually PASS one. This suite calls the REAL service methods (only the I/O
 * boundary — repo/redis/RabbitMQ/gRPC — is mocked by tests/setup/global-mocks.ts)
 * and asserts the `community.system_message` event published to chat-service
 * always carries `visibleToUserId: targetUserId`, so:
 *   - the affected member's own channel/history receives the line, and
 *   - the central registry (SYSTEM_MESSAGE_VISIBILITY = PERSONAL) is honored —
 *     never left to default to a community-wide broadcast.
 */
import { communityRepository } from "../../src/repositories/community.repository.js";
import { communityService } from "../../src/services/community.service.js";
import {
  publishCommunitySystemMessageForChatSafe,
  publishCommunityMemberMuteRetractedForChatSafe,
} from "../../src/messaging/publish-community-chat.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const sysMsg = publishCommunitySystemMessageForChatSafe as jest.Mock;
const muteRetracted =
  publishCommunityMemberMuteRetractedForChatSafe as jest.Mock;

const CID = "a".repeat(24);
const CALLER = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

function activeMembership(role: string) {
  return { status: "ACTIVE", role };
}

function activeMember(userId: string) {
  return {
    userId,
    status: "ACTIVE",
    role: "MEMBER",
    snapshotUsername: "target",
    snapshotDisplayName: "Target User",
    snapshotAvatarKey: null,
  };
}

describe("communityService.muteMember/unmuteMember — PERSONAL system message delivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repo.findById.mockResolvedValue({ id: CID, status: "ACTIVE" });
    repo.findMembership.mockResolvedValue(activeMembership("MODERATOR"));
    repo.findMemberByUserId.mockResolvedValue(activeMember(TARGET));
    repo.upsertMemberMute.mockResolvedValue({
      mutedBy: CALLER,
      reason: null,
      createdAt: new Date(),
      mutedUntil: null,
    });
    repo.findMemberMute.mockResolvedValue({
      mutedUntil: new Date(Date.now() + 60_000),
    });
    repo.deleteMemberMute.mockResolvedValue(undefined);
  });

  it("muteMember emits a PERSONAL MEMBER_MUTED system message targeted at the muted member — never a broadcast", async () => {
    await communityService.muteMember(CID, CALLER, TARGET, 60, "spam");

    expect(sysMsg).toHaveBeenCalledTimes(1);
    const payload = sysMsg.mock.calls[0][0] as {
      communityId: string;
      systemMessageType: string;
      visibleToUserId?: string;
      metadata: Record<string, unknown>;
    };
    expect(payload.communityId).toBe(CID);
    expect(payload.systemMessageType).toBe("MEMBER_MUTED");
    // The critical assertion: the affected member must be set as the
    // recipient so chat-service's PERSONAL routing delivers it to THEM.
    expect(payload.visibleToUserId).toBe(TARGET);
    expect(payload.metadata.targetUserId).toBe(TARGET);
  });

  it("unmuteMember posts NO chat system message — MEMBER_UNMUTED is HIDDEN (silent unmute)", async () => {
    await communityService.unmuteMember(CID, CALLER, TARGET);

    // Unmute is silent in chat: the composer re-enables via the separate
    // `community:member:unmuted` socket event and the prior mute line is
    // retracted (asserted below). No "You were unmuted" bubble is emitted.
    expect(sysMsg).not.toHaveBeenCalled();
  });

  it("unmuteMember also retracts the current mute session's PERSONAL MEMBER_MUTED line — the mute and unmute lines never stack together", async () => {
    await communityService.unmuteMember(CID, CALLER, TARGET);

    expect(muteRetracted).toHaveBeenCalledTimes(1);
    expect(muteRetracted).toHaveBeenCalledWith({
      communityId: CID,
      userId: TARGET,
    });
  });

  it("muteMember does NOT retract anything — retraction only fires on unmute", async () => {
    await communityService.muteMember(CID, CALLER, TARGET, 60, "spam");

    expect(muteRetracted).not.toHaveBeenCalled();
  });
});
