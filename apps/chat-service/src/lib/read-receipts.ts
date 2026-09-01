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
import { resolveMediaUrlMap, urlFromMap } from "./media-resolve.js";
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

/**
 * One member's EXPOSABLE read pointer — how far they have read *while giving
 * receipts*, and when that pointer last moved.
 *
 * Rows written before this pair existed carry no `receiptRead*` at all. For
 * those the plain read pointer IS the receipt: they were all written under the
 * old always-expose behaviour, so falling back keeps every blue tick the fleet
 * can already see instead of blanking history on deploy. Once a member reads
 * once under the new write path the key exists — including when receipts are
 * off, where it is frozen at its previous value — and the fallback stops.
 */
export function receiptCursorOf(member: {
  lastReadMessageId?: string | null;
  lastReadAt?: Date | null;
  receiptReadMessageId?: string | null;
  receiptReadAt?: Date | null;
}): { messageId: string | null; readAt: Date | null } {
  const written = member.receiptReadMessageId !== undefined;
  return written
    ? {
        messageId: member.receiptReadMessageId ?? null,
        readAt: member.receiptReadAt ?? null,
      }
    : {
        messageId: member.lastReadMessageId ?? null,
        readAt: member.lastReadAt ?? null,
      };
}

/**
 * {@link receiptCursorOf} for a PRIVATE room, whose pointers live in per-user
 * JSON maps rather than a membership row. Same legacy rule: no key for this
 * user in the receipt map means the row predates it, so the plain read pointer
 * stands in.
 */
export function privateReceiptCursorOf(
  room: {
    lastReadMessageIdByUser?: unknown;
    lastReadAtByUser?: unknown;
    receiptReadMessageIdByUser?: unknown;
    receiptReadAtByUser?: unknown;
  } | null,
  userId: string
): { messageId: string | null; readAt: Date | null } {
  const asMap = (v: unknown) => (v ?? {}) as Record<string, string | null>;
  const receiptIds = asMap(room?.receiptReadMessageIdByUser);
  const toDate = (raw: string | null | undefined) =>
    raw ? new Date(raw) : null;
  if (userId in receiptIds)
    return {
      messageId: receiptIds[userId] || null,
      readAt: toDate(asMap(room?.receiptReadAtByUser)[userId]),
    };
  return {
    messageId: asMap(room?.lastReadMessageIdByUser)[userId] || null,
    readAt: toDate(asMap(room?.lastReadAtByUser)[userId]),
  };
}

/**
 * May a VIEWER be shown a receipt that happened at `readAt`?
 *
 * `readReceiptsEnabledAt` is the instant the viewer last switched receipts back
 * ON. A receipt older than that line was withheld from them while the switch
 * was off, and the switch flipping is not itself a read event — so it stays
 * withheld forever. 0 (never switched off) admits everything, and so does a
 * receipt with no timestamp at all: those are legacy rows, already visible.
 *
 * This is the VIEWER half of the point-in-time rule; the READER half is the
 * frozen `receiptRead*` cursor above. Both are needed: the frozen cursor stops
 * a reader from leaking reads they took with the switch off, and this stops a
 * viewer's own off-period from being back-filled when they switch on again.
 */
export function receiptVisibleToViewer(
  viewerReadReceiptsEnabledAt: number,
  readAt: Date | null | undefined
): boolean {
  if (!viewerReadReceiptsEnabledAt) return true;
  if (!readAt) return true;
  return readAt.getTime() >= viewerReadReceiptsEnabledAt;
}

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
export async function assertMaySeeReadReceipts(
  userId: string
): Promise<number> {
  const { readReceipts, readReceiptsEnabledAt } =
    await getAccountChatSettings(userId);
  if (!readReceipts) throw new ForbiddenError("CHAT_READ_RECEIPTS_DISABLED");
  // Returned, not just checked: the sheet must also drop the readers whose
  // receipt predates this viewer's own OFF → ON line.
  return readReceiptsEnabledAt;
}

/**
 * Hydrate a set of readers into the wire payload: newest read first, capped,
 * receipt-disabled readers dropped, names/avatars/presence from the Redis-backed
 * snapshot cache (one batched lookup, no per-user round trip).
 */
export async function buildReadReceipts(params: {
  messageId: string;
  candidates: ReadReceiptCandidate[];
  /** The viewer's own OFF → ON line — {@link assertMaySeeReadReceipts}. */
  viewerReadReceiptsEnabledAt: number;
  userSnapshotService: UserSnapshotService;
  cacheRepo: CacheRepository;
}): Promise<ReadReceiptsPayload> {
  const sorted = [...params.candidates]
    .filter((c) =>
      receiptVisibleToViewer(params.viewerReadReceiptsEnabledAt, c.readAt)
    )
    .sort((a, b) => (b.readAt?.getTime() ?? 0) - (a.readAt?.getTime() ?? 0));
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

  // Snapshots persist the raw storage objectKey; the sheet must ship a signed
  // download URL like every other read path (enrichMessages, rosters). Without
  // this the client got a bare key and fell back to initials.
  const urlMap = await resolveMediaUrlMap(
    visible.map((c) => {
      const avatar = snapshots.get(c.userId)?.avatar;
      return typeof avatar === "string" ? avatar : null;
    })
  );

  const users: ReadReceiptUser[] = visible.map((c) => {
    const snapshot = snapshots.get(c.userId) ?? null;
    return {
      userId: c.userId,
      fullName: resolveDisplayName(snapshot),
      username: String(snapshot?.memberId ?? snapshot?.username ?? ""),
      avatar: urlFromMap(
        urlMap,
        typeof snapshot?.avatar === "string" ? snapshot.avatar : null
      ),
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
