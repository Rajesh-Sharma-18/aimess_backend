/**
 * Request shape for community-service's `UpdateMessageActivity` RPC, kept in its
 * own module so it can be unit-tested: `community.client.ts` itself is
 * unloadable under Jest (import.meta.url + proto loader) and is globally mocked.
 */
export interface UpdateMessageActivityParams {
  communityId: string;
  /** epoch ms; ignored in self-hide mode (selfUserId set). */
  lastMessageAt?: number;
  lastMessageId?: string;
  senderUserId?: string;
  senderUsername?: string;
  messagePreview?: string;
  /** default "message" when omitted. */
  activityType?: string;
  /**
   * Delete-for-me personal self-hide overlay: when set, ONLY
   * lastActivityUserId/lastActivitySelfPreview are written community-service-
   * side — every canonical field above is ignored. Leave unset (or "") for
   * the normal canonical bump (message send/edit/delete-for-everyone).
   */
  selfUserId?: string;
  selfPreview?: string;
  /**
   * ROLLBACK mode (epoch ms; omit/0 = off). community-service's canonical bump is
   * forward-only, so it cannot express "the last message was deleted — fall back
   * to the previous one, which is OLDER". Set this to the REMOVED message's
   * `createdAt` and pass the previous-visible message's real `createdAt` as
   * `lastMessageAt`: the write then applies backward, but only while the stored
   * `lastActivityAt` is not newer than this (a message that landed after the
   * delete wins and the rollback is skipped).
   */
  rollbackNotNewerThan?: number;
  clientMessageId?: string | null;
  seq?: number;
  contentType?: string;
}

/**
 * Wire shape of `UpdateMessageActivityRequest` (community.proto). Exported so a
 * dropped field is a test failure rather than a silent default: proto3 has no
 * required fields, so a key missing from this literal is transmitted as its
 * zero value and the server cannot tell it apart from a deliberate 0/"".
 *
 * That bit us exactly once: fields 10-13 were absent, so every delete-for-
 * everyone of a community's last message sent `rollbackNotNewerThan: 0`, which
 * put community-service on its FORWARD-ONLY `updateLastActivity` branch. The
 * backward write was rejected and `GET /communities/mine` kept previewing the
 * deleted message across reloads and re-logins.
 */
export function toUpdateMessageActivityRequest(
  p: UpdateMessageActivityParams
): Record<string, unknown> {
  return {
    communityId: p.communityId,
    // int64 fields ride as strings (`longs: String` in the proto loader).
    lastMessageAt: String(p.lastMessageAt ?? 0),
    lastMessageId: p.lastMessageId ?? "",
    senderUserId: p.senderUserId ?? "",
    senderUsername: p.senderUsername ?? "",
    messagePreview: p.messagePreview ?? "",
    activityType: p.activityType ?? "message",
    selfUserId: p.selfUserId ?? "",
    selfPreview: p.selfPreview ?? "",
    clientMessageId: p.clientMessageId ?? "",
    seq: p.seq ?? 0,
    contentType: p.contentType ?? "",
    rollbackNotNewerThan: String(p.rollbackNotNewerThan ?? 0),
  };
}
