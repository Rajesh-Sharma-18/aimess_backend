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
/**
 * `getUserSnapshotsMap` never omits an id: an id it could resolve from neither
 * user-service nor auth-service comes back as an all-empty placeholder. That
 * placeholder is indistinguishable from "this user removed their picture" by
 * the avatar field alone, so trusting it would BLANK a perfectly good stored
 * avatar every time the profile lookup degrades. Any real profile carries at
 * least a display name or a username, so require one before treating the
 * snapshot as authoritative — an unresolved id then keeps whatever the row
 * stored (stale beats blank).
 */
function isResolvedSnapshot(snapshot: Record<string, unknown>): boolean {
  if (snapshot.isDeletedUser === true) return true;
  for (const field of ["displayName", "fullName", "memberId", "username"]) {
    const value = snapshot[field];
    if (typeof value === "string" && value.trim()) return true;
  }
  return false;
}

export type SenderIdentity = {
  isDeleted: boolean;
  /** CURRENT avatar object key from the live profile ("" when unset). */
  avatar: string;
};

/**
 * The live identity facts a stored group/community row needs re-checked at
 * read time: whether the account is gone, and what its avatar is NOW.
 *
 * One batched (Redis-cached) snapshot call for the whole page. Empty map when
 * there is nothing to look up — and, because `getUserSnapshotsMap` degrades
 * internally rather than throwing, a user-service blip costs display accuracy
 * for one cache-TTL window instead of 500-ing a history read.
 */
export async function collectSenderIdentities(
  userIds: Array<string | null | undefined>,
  userSnapshotService: UserSnapshotService,
  cacheRepo: CacheRepository
): Promise<Map<string, SenderIdentity>> {
  const unique = [...new Set(userIds.filter((id): id is string => !!id))];
  const identities = new Map<string, SenderIdentity>();
  if (unique.length === 0) return identities;

  const snapshots = await userSnapshotService.getUserSnapshotsMap(
    unique,
    cacheRepo
  );
  for (const id of unique) {
    const snapshot = snapshots.get(id);
    if (!snapshot || !isResolvedSnapshot(snapshot)) continue;
    const avatar = snapshot.avatar;
    identities.set(id, {
      isDeleted: snapshot.isDeletedUser === true,
      avatar: typeof avatar === "string" ? avatar : "",
    });
  }
  return identities;
}

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
  const identities = await collectSenderIdentities(
    userIds,
    userSnapshotService,
    cacheRepo
  );
  const deleted = new Set<string>();
  for (const [id, identity] of identities) {
    if (identity.isDeleted) deleted.add(id);
  }
  return deleted;
}

/**
 * Every avatar object key `refreshWireSenderAvatar` may stamp onto a page, so
 * the caller can presign them in the SAME batch as the stored keys.
 */
export function liveAvatarKeys(
  identities: Map<string, SenderIdentity>
): string[] {
  return [...identities.values()].map((i) => i.avatar).filter(Boolean);
}

/**
 * Swap the stored (frozen-at-send-time) sender avatar KEY on a wire row for the
 * sender's current one, so a profile-picture change is reflected on history the
 * user has already sent — without rewriting a single stored row.
 *
 * Runs on the raw key, BEFORE the caller presigns it. Private rows are not
 * affected (they already resolve the sender from a live snapshot); SYSTEM rows
 * are skipped for the same reason `anonymizeWireSender` skips them — both
 * serializers deliberately blank the sender fields there.
 *
 * A sender missing from `identities` (snapshot lookup degraded) keeps whatever
 * the row stored: stale beats blank.
 */
export function refreshWireSenderAvatar(
  wire: Record<string, unknown>,
  identities: Map<string, SenderIdentity>
): void {
  if (String(wire.contentType ?? "").toUpperCase() === "SYSTEM") return;

  const senderId =
    typeof wire.senderId === "string" && wire.senderId
      ? wire.senderId
      : typeof wire.sentBy === "string"
        ? wire.sentBy
        : "";
  const identity = senderId ? identities.get(senderId) : undefined;
  if (identity && !identity.isDeleted) wire.senderAvatar = identity.avatar;

  const quote = wire.quoteData as Record<string, unknown> | null | undefined;
  if (quote && typeof quote === "object") {
    const quotedId =
      typeof quote.senderId === "string" && quote.senderId
        ? quote.senderId
        : typeof quote.sentBy === "string"
          ? quote.sentBy
          : "";
    const quoted = quotedId ? identities.get(quotedId) : undefined;
    if (quoted && !quoted.isDeleted) {
      wire.quoteData = { ...quote, senderAvatar: quoted.avatar };
    }
  }
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
