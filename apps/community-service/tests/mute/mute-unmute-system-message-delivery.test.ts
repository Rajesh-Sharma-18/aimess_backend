/**
 * communityService.muteMember / unmuteMember — system-message delivery.
 *
 * Regression coverage for a real end-to-end gap that pure unit tests of
 * CommunitySystemMessageService.post() (chat-service) could never catch: they
 * assert the chat-service formatter behaves correctly GIVEN a `visibleToUserId`,
 * but never exercise whether community-service's `muteMember` / `unmuteMember`
 * actually PASS one. This suite calls the REAL service methods (only the I/O
 * boundary — repo/redis/RabbitMQ/gRPC — is mocked by tests/setup/global-mocks.ts)
 * and asserts the `community.system_message` event published to chat-service
 * always carries `visibleToUserId: targetUserId`, so:
 *   - the affected member's own channel/history receives their own notice, and
 *   - the MODERATION audit copy is published WITHOUT a recipient, so
 *     chat-service scopes it to the community's owner/admin/moderators instead
 *     of broadcasting it to the room.
 *
 * MUTE publishes BOTH copies of MEMBER_MUTED (personal notice + audit line);
 * UNMUTE publishes the audit line ONLY — the member learns the mute is over from
 * `community:member:unmuted` plus the retraction of the stale mute line, so a
 * "You were unmuted" bubble would be a second copy of the same fact.
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

describe("communityService.muteMember/unmuteMember — system message delivery", () => {
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

  it("muteMember emits BOTH the muted member's own notice AND the moderator-only audit line", async () => {
    await communityService.muteMember(CID, CALLER, TARGET, 60, "spam");

    expect(sysMsg).toHaveBeenCalledTimes(2);
    const payloads = sysMsg.mock.calls.map(
      (c: unknown[]) =>
        c[0] as {
          communityId: string;
          systemMessageType: string;
          visibleToUserId?: string;
          metadata: Record<string, unknown>;
        }
    );
    for (const payload of payloads) {
      expect(payload.communityId).toBe(CID);
      expect(payload.systemMessageType).toBe("MEMBER_MUTED");
      expect(payload.metadata.targetUserId).toBe(TARGET);
    }
    // The affected member must be the recipient of exactly ONE of them, so
    // chat-service delivers "You are muted until …" to THEM …
    const personal = payloads.filter((p) => p.visibleToUserId === TARGET);
    expect(personal).toHaveLength(1);
    // … and the other must carry NO recipient, which is what makes chat-service
    // scope the audit line to owner/admin/moderators instead of the whole room.
    const audit = payloads.filter((p) => !p.visibleToUserId);
    expect(audit).toHaveLength(1);
  });

  it("unmuteMember posts the audit line ONLY — never a bubble in the member's own history", async () => {
    await communityService.unmuteMember(CID, CALLER, TARGET);

    expect(sysMsg).toHaveBeenCalledTimes(1);
    const payload = sysMsg.mock.calls[0][0] as {
      systemMessageType: string;
      visibleToUserId?: string;
      metadata: Record<string, unknown>;
    };
    expect(payload.systemMessageType).toBe("MEMBER_UNMUTED");
    // No recipient ⇒ moderator-scoped audit line. The unmuted member sees
    // nothing new in chat: the composer re-enables via the separate
    // `community:member:unmuted` event and the stale mute line is retracted
    // (asserted below), so a bubble would duplicate that.
    expect(payload.visibleToUserId).toBeUndefined();
    expect(payload.metadata.targetUserId).toBe(TARGET);
  });

  it("unmuteMember also retracts the current mute session's PERSONAL MEMBER_MUTED line — the stale mute notice never outlives the mute", async () => {
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
