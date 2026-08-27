/**
 * Auto-unmute sweep — `communityService.expireDueMutes(limit)`.
 *
 * For each TIMED mute whose `mutedUntil` has passed, the sweep ATOMICALLY claims
 * the row (so side-effects fire exactly once across instances/redeliveries) and
 * then, WITHOUT a push (Telegram parity — a lapsing timer must not ping the user
 * at an arbitrary hour), runs the same unmute side-effects as a manual unmute:
 *   - audit MEMBER_UNMUTED with metadata.source = "auto"
 *   - mirror the unmute into chat-service (mute_synced isMuted=false) + emit the
 *     community:member:unmuted socket event
 *   - retract the PERSONAL MEMBER_MUTED chat message (mute_msg_retracted). No
 *     "You were unmuted" line is posted — MEMBER_UNMUTED is HIDDEN (silent unmute)
 *
 * The I/O boundary (repo, redis publishers, chat publishers, push publishers) is
 * mocked by tests/setup/global-mocks.ts; the real service orchestration runs.
 */

import { communityRepository } from "../../src/repositories/community.repository.js";
import { communityService } from "../../src/services/community.service.js";
import {
  publishCommunityMemberMuteSyncedForChatSafe,
  publishCommunityMemberMuteRetractedForChatSafe,
  publishCommunitySystemMessageForChatSafe,
} from "../../src/messaging/publish-community-chat.js";
import { publishCommunityMemberUnmutedSafe } from "../../src/messaging/publish-community.js";
import { publishCommunityRoomEvent } from "@aimess/redis";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const muteSync = publishCommunityMemberMuteSyncedForChatSafe as jest.Mock;
const muteRetracted =
  publishCommunityMemberMuteRetractedForChatSafe as jest.Mock;
const systemMessage = publishCommunitySystemMessageForChatSafe as jest.Mock;
const roomEvent = publishCommunityRoomEvent as jest.Mock;
const pushUnmuted = publishCommunityMemberUnmutedSafe as jest.Mock;

const CID = "a".repeat(24);
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

function expiredMute(id: string, userId: string) {
  return {
    id,
    communityId: CID,
    userId,
    mutedBy: "mod",
    reason: null,
    mutedUntil: new Date(Date.now() - 60_000), // expired 1m ago
    createdAt: new Date(Date.now() - 3_600_000),
  };
}

describe("communityService.expireDueMutes — auto-unmute sweep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repo.findMemberByUserId.mockResolvedValue({
      userId: U1,
      snapshotDisplayName: "Peter Parker",
      snapshotUsername: "peter",
      snapshotAvatarKey: null,
    });
  });

  it("expires each claimed mute and fires the unmute side-effects (no push)", async () => {
    repo.findExpiredMemberMutes.mockResolvedValue([
      expiredMute("m1", U1),
      expiredMute("m2", U2),
    ]);
    repo.claimExpiredMemberMute.mockResolvedValue(1); // both claims won

    const count = await communityService.expireDueMutes(50);

    expect(count).toBe(2);
    // Atomic claim attempted per row.
    expect(repo.claimExpiredMemberMute).toHaveBeenCalledTimes(2);
    // Audit recorded as an AUTO unmute.
    expect(repo.createAuditLog).toHaveBeenCalledTimes(2);
    expect(repo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MEMBER_UNMUTED",
        metadata: { source: "auto" },
      })
    );
    // Chat mirror lifted (isMuted=false) + roster socket unmuted event.
    expect(muteSync).toHaveBeenCalledWith(
      expect.objectContaining({ isMuted: false, mutedUntil: null })
    );
    expect(roomEvent).toHaveBeenCalledWith(
      expect.anything(),
      CID,
      "community:member:unmuted",
      expect.objectContaining({ isMuted: false })
    );
    // The lapsed session's mute line is retracted — a timer lapse leaves the
    // member's history in the same state a moderator unmute does. Unmute is
    // SILENT: MEMBER_UNMUTED is HIDDEN, so NO "You were unmuted" bubble is posted.
    expect(muteRetracted).toHaveBeenCalledTimes(2);
    expect(muteRetracted).toHaveBeenCalledWith({
      communityId: CID,
      userId: U1,
    });
    expect(systemMessage).not.toHaveBeenCalled();
    // Auto-unmute is SILENT — no push to the member.
    expect(pushUnmuted).not.toHaveBeenCalled();
  });

  it("is idempotent: a lost claim (count 0) fires NO side-effects", async () => {
    repo.findExpiredMemberMutes.mockResolvedValue([expiredMute("m1", U1)]);
    repo.claimExpiredMemberMute.mockResolvedValue(0); // another instance won

    const count = await communityService.expireDueMutes(50);

    expect(count).toBe(0);
    expect(repo.createAuditLog).not.toHaveBeenCalled();
    expect(muteRetracted).not.toHaveBeenCalled();
    expect(systemMessage).not.toHaveBeenCalled();
    expect(roomEvent).not.toHaveBeenCalled();
    expect(muteSync).not.toHaveBeenCalled();
  });

  it("returns 0 and does nothing when no mutes are due", async () => {
    repo.findExpiredMemberMutes.mockResolvedValue([]);

    const count = await communityService.expireDueMutes(50);

    expect(count).toBe(0);
    expect(repo.claimExpiredMemberMute).not.toHaveBeenCalled();
  });
});
