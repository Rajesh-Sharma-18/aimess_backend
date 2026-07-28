import type { PrivateRoomService } from "./private-room.service.js";
import type { GroupRoomService } from "./group-room.service.js";
import type { CommunityMessageService } from "./community-message.service.js";

export interface UnreadSummary {
  privateUnread: number;
  groupUnread: number;
  communityUnread: number;
  /** privateUnread + groupUnread — the combined Chats nav badge. */
  chatUnread: number;
}

/**
 * Cross-module unread totals for the main nav badges (Chats, Community).
 * Pure composition over each module's already-maintained unread signal —
 * PrivateRoomService/GroupRoomService/CommunityMessageService each own the
 * counting logic already (see their sumUnreadForUser); this just combines
 * the three, mirroring InboxService's private+group composition.
 */
export class UnreadSummaryService {
  constructor(
    private readonly privateRoomService: PrivateRoomService,
    private readonly groupRoomService: GroupRoomService,
    private readonly communityMessageService: CommunityMessageService
  ) {}

  async getUnreadSummary(userId: string): Promise<UnreadSummary> {
    const [privateUnread, groupUnread, communityUnread] = await Promise.all([
      this.privateRoomService.sumUnreadForUser(userId),
      this.groupRoomService.sumUnreadForUser(userId),
      this.communityMessageService.sumUnreadForUser(userId),
    ]);
    return {
      privateUnread,
      groupUnread,
      communityUnread,
      chatUnread: privateUnread + groupUnread,
    };
  }
}
