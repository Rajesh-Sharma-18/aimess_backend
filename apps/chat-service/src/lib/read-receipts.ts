/**
 * Per-message "Viewed by" (read receipts) — the WhatsApp/Telegram sheet behind
 * a message's "View Read Receipts" action, for PRIVATE, GROUP and COMMUNITY.
 *
 * There is deliberately NO per-message read table. Read state in this service
 * is a per-room WATERMARK (`PrivateRoom.lastReadMessageIdByUser`,
 * `GroupMember.lastReadMessageId`, `RoomMember.lastReadMessageId`) plus the
 * instant it last advanced (`lastReadAtByUser` / `lastReadAt`). A reader has
 * seen message M exactly when their watermark's `sequenceNumber >= M.sequenceNumber`
 * — the same comparison the list ticks and the group `memberReadSeq` cursors
 * already use. So this feature needs no schema change, no migration and no new
 * write path: it reads what mark-read already persists.
 *
 * The one honest limitation of that model: `readAt` is when the reader's
 * POINTER last moved, not the instant they laid eyes on this specific message.
 * For the newest message (the common case) they are the same; for an older one
 * inside a batch catch-up, `readAt` is the batch's timestamp. Storing a row per
 * (message, reader) would fix it and cost a write per message per member — not
 * a trade this product needs.
 *
 * Settings → Chat → Read Receipt is reciprocal here exactly as it is on the
 * ticks (see `account-chat-settings.ts`): a viewer who switched receipts OFF
 * gets no sheet at all, and a reader who switched them OFF never appears in
 * anyone's sheet.
 */
import { ForbiddenError } from "@aimess/errors";

import { getAccountChatSettings } from "./account-chat-settings.js";
import {
  resolveDisplayName,
  type UserSnapshotService,
} from "../services/user-snapshot.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";

/**
 * Hard cap on the sheet. A 5 000-member community can have thousands of
 * readers; hydrating them all would be one snapshot fan-out and one settings
 * lookup per reader on a modal open. The 200 most recent readers is what the
 * UI can meaningfully show — `hasMore` tells the client to render "200+".
 *
 * ponytail: fixed cap, no paging. Add a cursor here only if a real product
 * surface needs to scroll past 200 names.
 */
export const MAX_READ_RECEIPT_USERS = 200;

/** One member's read watermark, already proven to cover the target message. */
export interface ReadReceiptCandidate {
  userId: string;
  /** When the watermark last advanced. Null for legacy rows written before it existed. */
  readAt: Date | null;
}

export interface ReadReceiptUser {
  userId: string;
  fullName: string;
  username: string;
  avatar: string;
  /** Epoch ms (§6 wire convention). Null when the row predates `lastReadAt`. */
  readAt: number | null;
  isOnline: boolean;
}

export interface ReadReceiptsPayload {
  messageId: string;
  totalReadCount: number;
  /** True when readers were dropped by {@link MAX_READ_RECEIPT_USERS}. */
  hasMore: boolean;
  users: ReadReceiptUser[];
}

/**
 * The VIEWER half of the reciprocal rule. Only the message's own sender ever
 * calls this endpoint, so "viewer" and "sender" are the same person: someone
 * who gives no receipts is shown none. Throws rather than returning an empty
 * list so the client can hide the menu item instead of opening an empty sheet.
 */
export async function assertMaySeeReadReceipts(userId: string): Promise<void> {
  const { readReceipts } = await getAccountChatSettings(userId);
  if (!readReceipts) throw new ForbiddenError("CHAT_READ_RECEIPTS_DISABLED");
}

/**
 * Hydrate a set of readers into the wire payload: newest read first, capped,
 * receipt-disabled readers dropped, names/avatars/presence from the Redis-backed
 * snapshot cache (one batched lookup, no per-user round trip).
 */
export async function buildReadReceipts(params: {
  messageId: string;
  candidates: ReadReceiptCandidate[];
  userSnapshotService: UserSnapshotService;
  cacheRepo: CacheRepository;
}): Promise<ReadReceiptsPayload> {
  const sorted = [...params.candidates].sort(
    (a, b) => (b.readAt?.getTime() ?? 0) - (a.readAt?.getTime() ?? 0)
  );
  const hasMore = sorted.length > MAX_READ_RECEIPT_USERS;
  const capped = sorted.slice(0, MAX_READ_RECEIPT_USERS);

  // The READER half of the reciprocal rule. Cached 60s per user, and only over
  // the capped slice, so this is bounded no matter how large the room is.
  const givesReceipts = new Map(
    await Promise.all(
      capped.map(
        async (c) =>
          [
            c.userId,
            (await getAccountChatSettings(c.userId)).readReceipts,
          ] as const
      )
    )
  );
  const visible = capped.filter((c) => givesReceipts.get(c.userId) !== false);

  const snapshots = await params.userSnapshotService.getUserSnapshotsMap(
    visible.map((c) => c.userId),
    params.cacheRepo
  );

  const users: ReadReceiptUser[] = visible.map((c) => {
    const snapshot = snapshots.get(c.userId) ?? null;
    return {
      userId: c.userId,
      fullName: resolveDisplayName(snapshot),
      username: String(snapshot?.memberId ?? snapshot?.username ?? ""),
      avatar: String(snapshot?.avatar ?? ""),
      readAt: c.readAt ? c.readAt.getTime() : null,
      isOnline: snapshot?.isOnline === true,
    };
  });

  return {
    messageId: params.messageId,
    totalReadCount: users.length,
    hasMore,
    users,
  };
}

/**
 * Keep only the members whose read watermark covers `targetSequence`.
 * `seqByMessageId` is the caller's already-batched id → sequenceNumber lookup.
 */
export function readersAtOrPast(
  members: Array<{
    userId: string;
    lastReadMessageId: string | null;
    lastReadAt: Date | null;
  }>,
  seqByMessageId: Map<string, number>,
  targetSequence: number
): ReadReceiptCandidate[] {
  const readers: ReadReceiptCandidate[] = [];
  for (const member of members) {
    if (!member.lastReadMessageId) continue;
    const seq = seqByMessageId.get(member.lastReadMessageId) ?? 0;
    if (seq < targetSequence) continue;
    readers.push({ userId: member.userId, readAt: member.lastReadAt });
  }
  return readers;
}
