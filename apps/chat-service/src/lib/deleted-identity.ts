import { DELETED_ACCOUNT_DISPLAY_NAME } from "@aimess/constants";

import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "../services/user-snapshot.service.js";

/**
 * Deleted-account identity scrubbing for the message read paths.
 *
 * Private messages don't need this: they resolve the sender from a live user
 * snapshot on every read, so `resolveDisplayName` already substitutes
 * "Deleted Account" for them. Group and community rows are the exception —
 * they DENORMALIZE `senderName`/`senderAvatar` at send time and never look at
 * a snapshot again, which is exactly how a deleted account's old name stays
 * frozen into years of history. The same applies to `quoteData` (the reply /
 * quoted-message preview) and to SYSTEM rows, whose `systemData` carries the
 * actor's and targets' names verbatim.
 *
 * The fix is read-time, not write-time: nothing rewrites stored rows. A page of
 * messages is scanned for the distinct user ids it mentions, those are looked
 * up in ONE batched (Redis-cached) snapshot call, and only the ids that come
 * back deleted are overwritten on the wire. Cost on the common page, where
 * nobody is deleted, is a single Redis MGET.
 */

/**
 * Which of `userIds` belong to deleted accounts. Empty set when there is
 * nothing to look up, and empty on any snapshot failure — this is display
 * scrubbing, and a user-service blip must not 500 a history read. The blip
 * window is bounded by the snapshot cache TTL, and the same page re-renders
 * correctly on the next read.
 */
export async function collectDeletedUserIds(
  userIds: Array<string | null | undefined>,
  userSnapshotService: UserSnapshotService,
  cacheRepo: CacheRepository
): Promise<Set<string>> {
  const unique = [...new Set(userIds.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Set();

  const snapshots = await userSnapshotService.getUserSnapshotsMap(
    unique,
    cacheRepo
  );
  const deleted = new Set<string>();
  for (const id of unique) {
    if (snapshots.get(id)?.isDeletedUser === true) deleted.add(id);
  }
  return deleted;
}

/**
 * Every user id one stored row can name: the sender (`senderId` on group rows,
 * `sentBy` on community rows), the quoted message's original sender, and the
 * actor/target ids inside a SYSTEM row's `systemData`.
 */
export function collectRowUserIds(row: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value) ids.push(value);
  };

  push(row.senderId);
  push(row.sentBy);

  const quote = row.quoteData as Record<string, unknown> | null | undefined;
  if (quote && typeof quote === "object") {
    push(quote.senderId);
    push(quote.sentBy);
  }

  const systemData = (row.systemData ?? row.systemMetadata) as
    | Record<string, unknown>
    | null
    | undefined;
  if (systemData && typeof systemData === "object") {
    push(systemData.actorId);
    push(systemData.targetUserId);
    if (Array.isArray(systemData.targetUserIds)) {
      for (const id of systemData.targetUserIds) push(id);
    }
  }

  return ids;
}

/**
 * Overwrite the sender identity on an already-serialized wire row when that
 * sender's account is deleted, and stamp `isDeletedUser` either way so clients
 * can gate profile navigation and member actions off one boolean instead of
 * string-matching the display name.
 *
 * SYSTEM rows are left alone: both the group and community serializers
 * deliberately blank `senderName`/`senderAvatar` on them (the actor lives in
 * `systemData`), and re-populating those fields here would make a system line
 * render as if "Deleted Account" had sent it.
 */
export function anonymizeWireSender(
  wire: Record<string, unknown>,
  deletedUserIds: Set<string>
): void {
  const senderId =
    typeof wire.senderId === "string" && wire.senderId
      ? wire.senderId
      : typeof wire.sentBy === "string"
        ? wire.sentBy
        : "";
  const isDeletedSender = Boolean(senderId) && deletedUserIds.has(senderId);
  wire.isDeletedUser = isDeletedSender;

  const isSystem = String(wire.contentType ?? "").toUpperCase() === "SYSTEM";
  if (isDeletedSender && !isSystem) {
    wire.senderName = DELETED_ACCOUNT_DISPLAY_NAME;
    wire.senderAvatar = "";
    // Private rows expose the same value under a second name; only overwrite it
    // when the row actually carries it, so no surface gains a new field.
    if ("senderDisplayName" in wire) {
      wire.senderDisplayName = DELETED_ACCOUNT_DISPLAY_NAME;
    }
    if ("senderMemberId" in wire) wire.senderMemberId = "";
  }

  const quote = wire.quoteData as Record<string, unknown> | null | undefined;
  if (quote && typeof quote === "object") {
    const quotedSenderId =
      typeof quote.senderId === "string" && quote.senderId
        ? quote.senderId
        : typeof quote.sentBy === "string"
          ? quote.sentBy
          : "";
    if (quotedSenderId && deletedUserIds.has(quotedSenderId)) {
      wire.quoteData = {
        ...quote,
        senderName: DELETED_ACCOUNT_DISPLAY_NAME,
        senderAvatar: "",
        isDeletedUser: true,
      };
    }
  }
}

/**
 * Replace the names baked into a SYSTEM row's `systemData` for any participant
 * whose account is deleted, so "Alice added Bob" renders as
 * "Alice added Deleted Account" once Bob is gone.
 *
 * Returns the input unchanged (same reference) when nothing needs scrubbing —
 * the caller can then skip rebuilding the row entirely. The ids themselves are
 * preserved: the renderer compares them against the viewer to pick the
 * second-person wording ("You were added"), and blanking them would break that
 * for the deleted user's own remaining sessions and, more importantly, for
 * every OTHER viewer of a line that also names them.
 */
export function anonymizeSystemData(
  systemData: Record<string, unknown>,
  deletedUserIds: Set<string>
): Record<string, unknown> {
  if (deletedUserIds.size === 0) return systemData;

  const actorDeleted =
    typeof systemData.actorId === "string" &&
    deletedUserIds.has(systemData.actorId);
  const targetDeleted =
    typeof systemData.targetUserId === "string" &&
    deletedUserIds.has(systemData.targetUserId);
  const targetIds = Array.isArray(systemData.targetUserIds)
    ? systemData.targetUserIds
    : null;
  const anyGroupedDeleted =
    targetIds?.some(
      (id) => typeof id === "string" && deletedUserIds.has(id)
    ) === true;

  if (!actorDeleted && !targetDeleted && !anyGroupedDeleted) return systemData;

  const next: Record<string, unknown> = { ...systemData };
  if (actorDeleted) next.actorName = DELETED_ACCOUNT_DISPLAY_NAME;
  if (targetDeleted) next.targetName = DELETED_ACCOUNT_DISPLAY_NAME;
  if (anyGroupedDeleted && targetIds) {
    const names = Array.isArray(systemData.targetNames)
      ? systemData.targetNames
      : [];
    next.targetNames = targetIds.map((id, i) =>
      typeof id === "string" && deletedUserIds.has(id)
        ? DELETED_ACCOUNT_DISPLAY_NAME
        : (names[i] ?? "")
    );
  }
  return next;
}
