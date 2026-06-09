import type { PrivateMessageService } from "./private-message.service.js";
import type { GroupMessageService } from "./group-message.service.js";

/**
 * V2 §3.3: REST incremental sync for offline-first clients that are NOT on the
 * socket (e.g. a freshly-launched, app-killed client doing background catch-up).
 *
 * Sync is **per-conversation** by design: `sequenceNumber` is a per-room counter,
 * so a single `next_seq` cursor is only meaningful within one room. Whole-account
 * "which conversations changed" discovery is served separately by
 * `GET /api/chat/inbox?after_ts=…`; this endpoint then gap-fills each room by seq.
 *
 * It reuses the same `catchup` path as the socket `chat:catchup`, so REST and
 * socket return identical events (tombstones + edits included).
 */
export class SyncService {
  constructor(
    private readonly privateMessageService: PrivateMessageService,
    private readonly groupMessageService: GroupMessageService
  ) {}

  async getRoomSync(params: {
    userId: string;
    convId: string;
    fromSeq: number;
    limit: number;
    type?: "private" | "group";
  }): Promise<{
    authorized: boolean;
    events: unknown[];
    next_seq: number;
    has_more: boolean;
    conversationType: "PRIVATE" | "GROUP" | null;
  }> {
    const { userId, convId, fromSeq, limit, type } = params;

    // Explicit type → single path. Otherwise probe private first, then group;
    // catchup returns authorized:false (never throws) for a non-participant, so
    // the probe is cheap and safe.
    if (type === "group") {
      const g = await this.groupMessageService.catchup({
        roomId: convId,
        userId,
        sinceSeq: fromSeq,
        limit,
      });
      return this.toResult(g, "GROUP");
    }

    if (type === "private") {
      const p = await this.privateMessageService.catchup({
        roomId: convId,
        userId,
        sinceSeq: fromSeq,
        limit,
      });
      return this.toResult(p, "PRIVATE");
    }

    const priv = await this.privateMessageService.catchup({
      roomId: convId,
      userId,
      sinceSeq: fromSeq,
      limit,
    });
    if (priv.authorized) return this.toResult(priv, "PRIVATE");

    const grp = await this.groupMessageService.catchup({
      roomId: convId,
      userId,
      sinceSeq: fromSeq,
      limit,
    });
    if (grp.authorized) return this.toResult(grp, "GROUP");

    // Not a participant of either — unauthorized.
    return {
      authorized: false,
      events: [],
      next_seq: fromSeq,
      has_more: false,
      conversationType: null,
    };
  }

  private toResult(
    r: {
      authorized: boolean;
      events: unknown[];
      hasMore: boolean;
      lastSeq: number;
    },
    conversationType: "PRIVATE" | "GROUP"
  ): {
    authorized: boolean;
    events: unknown[];
    next_seq: number;
    has_more: boolean;
    conversationType: "PRIVATE" | "GROUP";
  } {
    return {
      authorized: r.authorized,
      events: r.events,
      next_seq: r.lastSeq,
      has_more: r.hasMore,
      conversationType,
    };
  }
}
