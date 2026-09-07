import type { PrivateRoomService } from "./private-room.service.js";
import type { GroupRoomService } from "./group-room.service.js";
import type { CommunityMessageService } from "./community-message.service.js";

export interface UnreadSummary {
  privateUnread: number;
  groupUnread: number;
  communityUnread: number;
  /** privateUnread + groupUnread — combined unread MESSAGE total. */
  chatUnread: number;
  /** Private rooms holding at least one unread message. */
  privateUnreadConversations: number;
  /** Groups holding at least one unread message. */
  groupUnreadConversations: number;
  /** Communities holding at least one unread message. */
  communityUnreadConversations: number;
  /** private + group unread CONVERSATIONS — the Chats nav badge. */
  chatUnreadConversations: number;
}

/**
 * Cross-module unread totals for the main nav badges (Chats, Community).
 * Pure composition over each module's already-maintained unread signal —
 * PrivateRoomService/GroupRoomService/CommunityMessageService each own the
 * counting logic already (see their countUnreadForUser); this just combines
 * the three, mirroring InboxService's private+group composition.
 *
 * The nav badges render the *Conversations fields: a conversation with 500
 * unread messages contributes 1, because the badge answers "how many chats
 * need my attention", not "how many lines am I behind". The message totals
 * stay on the payload — per-row list badges and older clients still use them.
 */
export class UnreadSummaryService {
  constructor(
    private readonly privateRoomService: PrivateRoomService,
    private readonly groupRoomService: GroupRoomService,
    private readonly communityMessageService: CommunityMessageService
  ) {}

  async getUnreadSummary(userId: string): Promise<UnreadSummary> {
    const [privateStats, groupStats, communityStats] = await Promise.all([
      this.privateRoomService.countUnreadForUser(userId),
      this.groupRoomService.countUnreadForUser(userId),
      this.communityMessageService.countUnreadForUser(userId),
    ]);
    return {
      privateUnread: privateStats.messages,
      groupUnread: groupStats.messages,
      communityUnread: communityStats.messages,
      chatUnread: privateStats.messages + groupStats.messages,
      privateUnreadConversations: privateStats.conversations,
      groupUnreadConversations: groupStats.conversations,
      communityUnreadConversations: communityStats.conversations,
      chatUnreadConversations:
        privateStats.conversations + groupStats.conversations,
    };
  }
}
