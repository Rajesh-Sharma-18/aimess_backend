/**
 * V2 §1/§9: the single canonical ChatMessage wire shape, shared by every
 * transport so the client writes ONE mapper. Used by:
 *   - the Redis `message:new` / `message:edited` broadcasts (grpc/server.ts),
 *   - the REST forward/edit controller emits,
 *   - the REST history additive aliases (enrichMessages output).
 *
 * The object carries the canonical field names (id, roomId, conversationType,
 * senderName, senderRole, content, quoteData, reactions, serverTs, clientTs, …)
 * AND the legacy V1 aliases (messageId, conversationId, contentType, contentText,
 * contentJson, sentAt) so existing V1 clients keep working byte-for-byte.
 */

import {
  currentLocale,
  localizeQuotePreview,
  STORED_TEXT_LOCALE,
  t,
  type SupportedLocale,
} from "@aimess/constants";
import type { GroupInviteState } from "./group-invite-state.js";

export type ConversationKind = "PRIVATE" | "GROUP" | "COMMUNITY";

/** Canonical message type is UPPER-CASE everywhere (§1 single casing). */
export function normalizeMessageType(type: string | null | undefined): string {
  const raw = String(type ?? "").trim();
  return raw ? raw.toUpperCase() : "TEXT";
}

/** Map a stored message entity to its client wire shape: drop the internal
 *  `messageType` column, expose UPPER-CASE `contentType`. All other fields pass
 *  through unchanged. Null/undefined passes through untouched. */
export function toWireMessage<T extends { messageType?: string | null }>(
  entity: T
): Omit<T, "messageType"> & { contentType: string } {
  const { messageType, ...rest } = entity;
  return {
    ...rest,
    contentType: normalizeMessageType(messageType),
  } as Omit<T, "messageType"> & { contentType: string };
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export interface CanonicalQuote {
  messageId: string;
  senderId: string;
  /** Original sender's display name — NEVER "You", even when the viewer is the sender. */
  senderName: string;
  messageType: string;
  /** "Message deleted" when `isDeleted`, else the type-specific preview text. */
  preview: string;
  isDeleted: boolean;
  /** Full CDN/download URL, or `null` when unavailable — never a raw objectKey. */
  thumbnail: string | null;
  mimeType: string | null;
  /** Stable media identity of the quoted attachment's first file. Null for legacy quotes/non-media replies. */
  mediaId: string | null;
  durationMs: number;
  attachmentCount: number;
}

/** WhatsApp-style reply preview text — the SINGLE rule set for every reply
 *  snapshot, distinct from {@link convertMessageToPreview}'s list/push preview
 *  wording (that one keeps its own emoji/labels for the conversation list). */
export function buildReplyPreviewText(
  messageType: string,
  content: unknown,
  attachmentCount: number,
  locale: SupportedLocale = currentLocale()
): string {
  const type = normalizeMessageType(messageType);
  const c: Record<string, unknown> =
    content && typeof content === "object"
      ? (content as Record<string, unknown>)
      : { text: typeof content === "string" ? content : "" };
  const text = typeof c.text === "string" ? c.text : "";
  const files = Array.isArray(c.files)
    ? (c.files as Array<Record<string, unknown>>)
    : [];
  const fileName = (files[0]?.name as string) || "";

  switch (type) {
    case "TEXT":
      return text;
    case "IMAGE":
      return attachmentCount > 1
        ? t("QUOTE_IMAGE_MANY", locale, { count: attachmentCount })
        : t("QUOTE_IMAGE", locale);
    case "VIDEO":
      return t("QUOTE_VIDEO", locale);
    case "VOICE":
      return t("QUOTE_VOICE", locale);
    case "AUDIO":
      return t("QUOTE_AUDIO", locale);
    case "DOCUMENT":
      return fileName ? `📄 ${fileName}` : t("QUOTE_DOCUMENT", locale);
    case "GIF":
      return t("QUOTE_GIF", locale);
    case "STICKER":
      return t("QUOTE_STICKER", locale);
    case "CONTACT":
      return t("QUOTE_CONTACT", locale);
    case "LOCATION":
      return t("QUOTE_LOCATION", locale);
    // A call row's own `content.text` is its lifecycle sentence ("Voice call
    // cancelled") — the quote names the thing replied to, not its outcome.
    case "VOICE_CALL":
      return t("QUOTE_VOICE_CALL", locale);
    case "VIDEO_CALL":
      return t("QUOTE_VIDEO_CALL", locale);
    default:
      return text;
  }
}

/**
 * Normalize any stored quoteData shape to the canonical reply snapshot.
 * Tolerates the two legacy shapes so old persisted rows still render:
 *   - private legacy: { message, senderName }
 *   - group   legacy: { text, senderId, senderName, messageType, deletedForAll }
 * `isDeleted` always wins over the stored preview text — "Message deleted" is
 * derived here, on every read, so a delete never needs a preview-text rewrite.
 */
export function buildCanonicalQuote(
  raw: unknown,
  locale: SupportedLocale = currentLocale()
): CanonicalQuote | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  const isDeleted = Boolean(q.isDeleted ?? q.deletedForAll ?? false);
  const storedPreview =
    (q.preview as string) ?? (q.message as string) ?? (q.text as string) ?? "";
  return {
    messageId: (q.messageId as string) ?? (q.parentMessageId as string) ?? "",
    senderId: (q.senderId as string) ?? "",
    senderName: (q.senderName as string) ?? "",
    messageType: q.messageType
      ? normalizeMessageType(q.messageType as string)
      : "",
    // The stored preview was rendered in `STORED_TEXT_LOCALE` when the reply was
    // written; a pure label is re-rendered for THIS reader, user text is not.
    preview: isDeleted
      ? t("QUOTE_DELETED", locale)
      : typeof storedPreview === "string"
        ? localizeQuotePreview(
            storedPreview,
            typeof q.messageType === "string" ? q.messageType : "",
            locale
          )
        : "",
    isDeleted,
    thumbnail:
      typeof q.thumbnail === "string" && q.thumbnail ? q.thumbnail : null,
    mimeType: typeof q.mimeType === "string" && q.mimeType ? q.mimeType : null,
    mediaId: typeof q.mediaId === "string" && q.mediaId ? q.mediaId : null,
    durationMs: typeof q.durationMs === "number" ? q.durationMs : 0,
    attachmentCount:
      typeof q.attachmentCount === "number" ? q.attachmentCount : 0,
  };
}

export interface ReplyQuoteSourceInput {
  messageId: string;
  senderId: string;
  senderName: string;
  messageType: string;
  /** Structured content: `{ text, files[], location, contact, sticker }`. */
  content: unknown;
  isDeleted: boolean;
  /**
   * True album size (sibling-row count for a split album send). Album sends
   * are persisted as one row PER file (see `lib/split-media-album.ts`), so a
   * single row's own `content.files` can never reveal the album total — the
   * caller must look up the sibling batch and pass its size here. Defaults to
   * `content.files.length` (0 or 1) when omitted.
   */
  attachmentCountOverride?: number;
}

/**
 * The SINGLE shared builder for a reply's persisted `quoteData` snapshot —
 * reused by private/group/community send paths so all three chat types
 * capture the same fields the same way (previously duplicated 3x inline).
 */
export function buildReplyQuoteSnapshot(
  input: ReplyQuoteSourceInput
): CanonicalQuote {
  const c =
    input.content && typeof input.content === "object"
      ? (input.content as Record<string, unknown>)
      : {};
  const files = Array.isArray(c.files)
    ? (c.files as Array<Record<string, unknown>>)
    : [];
  const first = files[0];
  // Prefer the stable objectKey over a (possibly presigned/expiring) stored
  // url; resolved to a full download URL on READ, never persisted resolved
  // (see `lib/media-resolve.ts`'s resolve-on-read contract).
  const thumbnailKey =
    (first?.objectKey as string) || (first?.url as string) || "";
  const mimeType = (first?.mime as string) || "";
  const mediaId = (first?.mediaId as string) || "";
  const durationMs = first?.durationMs;
  const attachmentCount = input.attachmentCountOverride ?? files.length;
  return {
    messageId: input.messageId,
    senderId: input.senderId,
    senderName: input.senderName,
    messageType: normalizeMessageType(input.messageType),
    // PERSISTED snapshot: pinned to `STORED_TEXT_LOCALE`, never the sender's
    // language — the row is read by everyone, and `buildCanonicalQuote`
    // re-renders the label per reader.
    preview: buildReplyPreviewText(
      input.messageType,
      input.content,
      attachmentCount,
      STORED_TEXT_LOCALE
    ),
    isDeleted: Boolean(input.isDeleted),
    thumbnail: thumbnailKey || null,
    mimeType: mimeType || null,
    mediaId: mediaId || null,
    durationMs: typeof durationMs === "number" ? durationMs : 0,
    attachmentCount,
  };
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  users: Array<{ userId: string; displayName: string; avatarUrl: string }>;
}

/**
 * Convert the stored reactions map `{ emoji: [{ userId, userName, avatar }] }`
 * into the canonical `ChatReactionGroup[]` broadcast shape (§2.4). `selfReacted`
 * is intentionally omitted — it is per-viewer and derived client-side from
 * `users[].userId === myUserId`.
 */
export function groupStoredReactions(raw: unknown): ReactionGroup[] {
  if (!raw || typeof raw !== "object") return [];
  const out: ReactionGroup[] = [];
  for (const [emoji, users] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(users) || users.length === 0) continue;
    out.push({
      emoji,
      count: users.length,
      users: users.map((u) => {
        const o = (u ?? {}) as Record<string, unknown>;
        return {
          userId: (o.userId as string) ?? "",
          displayName:
            (o.userName as string) ?? (o.displayName as string) ?? "",
          avatarUrl: (o.avatar as string) ?? "",
        };
      }),
    });
  }
  return out;
}

/**
 * Build the canonical client-facing `reactionGroups[]` for a message ROW: group
 * the stored reactor map per emoji and resolve each reactor's avatar key via
 * `resolveAvatar`. Pass `resolveUser` to enrich displayName and avatar from live
 * user snapshots — stored rows carry empty userName/avatar so without it
 * `users[].displayName` and `avatar` will be empty strings.
 */
export function buildReactionGroups(
  raw: unknown,
  resolveAvatar: (key: string) => string,
  resolveUser?: (
    userId: string
  ) => { displayName: string; avatarUrl: string } | undefined
): ReactionGroup[] {
  return groupStoredReactions(raw).map((group) => ({
    ...group,
    users: group.users.map((user) => {
      const snap = resolveUser?.(user.userId);
      return {
        userId: user.userId,
        displayName: snap?.displayName || user.displayName,
        // snap.avatarUrl is pre-resolved by the caller; fall back to resolving
        // the stored raw key so existing rows without snapshot data still work.
        avatarUrl: snap?.avatarUrl || resolveAvatar(user.avatarUrl),
      };
    }),
  }));
}

/** Canonical stored reactor entry — what each reaction array element looks like at rest. */
export interface StoredReactor {
  userId: string;
  userName: string;
  avatar: string;
  memberId: string;
}

/**
 * Coerce one stored reaction entry into the canonical {@link StoredReactor} shape.
 * Entries are objects `{ userId, userName, avatar, memberId }`; legacy rows may hold
 * a bare userId string, so tolerate both.
 */
function normalizeReactor(entry: unknown): StoredReactor {
  if (typeof entry === "string")
    return { userId: entry, userName: "", avatar: "", memberId: "" };
  const o = (entry ?? {}) as Record<string, unknown>;
  return {
    userId: (o.userId as string) ?? "",
    userName: (o.userName as string) ?? "",
    avatar: (o.avatar as string) ?? "",
    memberId: (o.memberId as string) ?? "",
  };
}

/**
 * Reduce the stored reactions map to `{ emoji: userId[] }`. Stored entries are
 * reactor OBJECTS, not bare ids — callers that need just the ids (counts, snapshot
 * fan-out, selfReacted checks) must go through this rather than indexing the array
 * elements as strings. Empty emoji buckets are dropped.
 */
export function reactionUserIdMap(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [emoji, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const ids = list.map((e) => normalizeReactor(e).userId).filter(Boolean);
    if (ids.length) out[emoji] = ids;
  }
  return out;
}

/**
 * Toggle `userId`'s `emoji` reaction in the stored map and return a NEW map (the
 * input is not mutated). One reaction per user (WhatsApp-style): the user is
 * first removed from EVERY emoji bucket, then re-added to `emoji` UNLESS that
 * was the bucket they were just removed from (same-emoji tap = toggle-off);
 * reacting with a different emoji than before replaces it instead of stacking.
 * Carried-over entries are normalized to the canonical object shape, so the
 * persisted result is always well-formed regardless of how legacy rows were
 * written.
 */
export function toggleStoredReaction(
  raw: unknown,
  userId: string,
  emoji: string
): Record<string, StoredReactor[]> {
  const out: Record<string, StoredReactor[]> = {};
  let hadSameEmoji = false;
  if (raw && typeof raw === "object") {
    for (const [e, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const normalized = list.map(normalizeReactor).filter((r) => r.userId);
      if (e === emoji && normalized.some((r) => r.userId === userId))
        hadSameEmoji = true;
      const entries = normalized.filter((r) => r.userId !== userId);
      if (entries.length) out[e] = entries;
    }
  }
  if (!hadSameEmoji) {
    out[emoji] = [
      ...(out[emoji] ?? []),
      { userId, userName: "", avatar: "", memberId: "" },
    ];
  }
  return out;
}

/**
 * SET `userId`'s reaction to exactly `emoji` — drops them from EVERY other bucket in one pass and
 * returns a NEW map. Re-setting the emoji they already have clears it (toggle-off), so a single
 * entry point covers add / replace / remove.
 *
 * Exists because a "change my reaction" is otherwise two toggles (remove old, add new): two writes,
 * two `message:reaction` broadcasts, and an intermediate state where the user has NO reaction —
 * which collapses the reaction row and visibly jumps the bubble height on clients. One call = one
 * write = one broadcast = no intermediate.
 */
export function setStoredReaction(
  raw: unknown,
  userId: string,
  emoji: string
): Record<string, StoredReactor[]> {
  const out: Record<string, StoredReactor[]> = {};
  let alreadyHadEmoji = false;
  if (raw && typeof raw === "object") {
    for (const [e, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const entries = list.map(normalizeReactor).filter((r) => r.userId);
      const kept = entries.filter((r) => r.userId !== userId);
      if (e === emoji && kept.length !== entries.length) alreadyHadEmoji = true;
      if (kept.length) out[e] = kept;
    }
  }
  if (!alreadyHadEmoji) {
    out[emoji] = [
      ...(out[emoji] ?? []),
      { userId, userName: "", avatar: "", memberId: "" },
    ];
  }
  return out;
}

/**
 * Flatten the stored reactions map into the thin `[{ userId, emoji }]` shape used
 * by the gRPC MessageDto (history fetch). Distinct from the grouped broadcast
 * shape — this matches the legacy proto field.
 */
export function flattenStoredReactions(
  raw: unknown
): Array<{ userId: string; emoji: string }> {
  if (!raw || typeof raw !== "object") return [];
  const out: Array<{ userId: string; emoji: string }> = [];
  for (const [emoji, users] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(users)) continue;
    for (const u of users) {
      const o = (u ?? {}) as Record<string, unknown>;
      const userId = (o.userId as string) ?? (typeof u === "string" ? u : "");
      if (userId) out.push({ userId, emoji });
    }
  }
  return out;
}

export type CommunityInvitationStatus =
  | "ACTIVE"
  | "EXPIRED"
  | "REVOKED"
  | "DELETED";

export interface CommunityInvitationSystemAction {
  type: "COMMUNITY_INVITATION";
  communityId: string;
  communityHandle?: string | null;
  communityName: string;
  /**
   * Presentational facts sourced from the message's own `systemData` — the
   * invite-context RPC does not return them. They live on the invitation object
   * so the client reads the whole card from ONE place instead of stitching it
   * together from `systemAction` + `systemData`.
   */
  communityAvatarUrl?: string | null;
  memberCount?: number;
  inviteCode?: string | null;
  deepLink: string;
  alreadyJoined: boolean;
  status: CommunityInvitationStatus;
  canOpen: boolean;
}

/**
 * True for a stored message that carries a COMMUNITY_INVITE card.
 *
 * Matches on `systemEvent`, which every such row has always carried, so this
 * covers BOTH the current rows (stored as `messageType: "COMMUNITY_INVITE"`)
 * and every legacy row written while invitations were generic
 * `messageType: "SYSTEM"`. Nothing needs backfilling.
 */
export function isCommunityInvitationMessage(m: {
  messageType?: string | null;
  systemEvent?: string | null;
}): boolean {
  const kind = normalizeMessageType(m.messageType);
  return (
    (kind === "SYSTEM" || kind === "COMMUNITY_INVITE") &&
    m.systemEvent === "COMMUNITY_INVITE"
  );
}

/**
 * The SINGLE builder for a COMMUNITY_INVITE message's `systemAction` card —
 * shared by the REST history mapper (`enrichMessages`, resolves fresh
 * membership/link state via gRPC) and the live `message:new`/`conv:updated`
 * publish path (`deliverInviteLinkDm`, which already knows the state is fresh
 * because it just created the invite). Callers differ only in how they source
 * `alreadyJoined`/`status`; the shape and the `canOpen` derivation live here once.
 */
export function buildCommunityInvitationAction(params: {
  communityId: string;
  communityName: string;
  communityHandle?: string | null;
  communityAvatarUrl?: string | null;
  memberCount?: number;
  inviteCode?: string | null;
  deepLink: string;
  alreadyJoined: boolean;
  status: CommunityInvitationStatus;
}): CommunityInvitationSystemAction {
  const {
    communityId,
    communityName,
    communityHandle = null,
    communityAvatarUrl = null,
    memberCount,
    inviteCode = null,
    deepLink,
    alreadyJoined,
    status,
  } = params;
  // A deleted community can never be opened. Otherwise the viewer can open it
  // either because they're already a member (the invite/link state is moot at
  // that point) or because the invite itself is still usable.
  const canOpen =
    status !== "DELETED" && (alreadyJoined || status === "ACTIVE");
  return {
    type: "COMMUNITY_INVITATION",
    communityId,
    communityHandle,
    communityName,
    communityAvatarUrl,
    memberCount,
    inviteCode,
    deepLink,
    alreadyJoined,
    status,
    canOpen,
  };
}

export type GroupInvitationStatus =
  | "ACTIVE"
  | "EXPIRED"
  | "REVOKED"
  | "DELETED";

export interface GroupInvitationSystemAction {
  type: "GROUP_INVITATION";
  groupId: string;
  groupName: string;
  groupAvatarUrl?: string | null;
  memberCount?: number;
  inviteToken?: string | null;
  deepLink: string;
  alreadyJoined: boolean;
  status: GroupInvitationStatus;
  /**
   * The authoritative button state — what the card must render, decided by the
   * server. `status` describes only the LINK; `state` folds in membership,
   * capacity and the rejoin block too, and is the field clients should switch
   * on. See `lib/group-invite-state.ts`. Optional so the live send path (which
   * has no viewer to resolve it for) can omit it.
   */
  state?: GroupInviteState;
  canOpen: boolean;
}

/** True for a stored message that carries a GROUP_INVITE card — see
 *  {@link isCommunityInvitationMessage} for why both kinds match. */
export function isGroupInvitationMessage(m: {
  messageType?: string | null;
  systemEvent?: string | null;
}): boolean {
  const kind = normalizeMessageType(m.messageType);
  return (
    (kind === "SYSTEM" || kind === "GROUP_INVITE") &&
    m.systemEvent === "GROUP_INVITE"
  );
}

/**
 * The SINGLE builder for a GROUP_INVITE message's `systemAction` card — mirrors
 * {@link buildCommunityInvitationAction}. Unlike the community variant, group
 * membership/link state lives in this same service, so callers resolve it via
 * direct repo reads (no gRPC) both at send time and on historical reads.
 */
export function buildGroupInvitationAction(params: {
  groupId: string;
  groupName: string;
  groupAvatarUrl?: string | null;
  memberCount?: number;
  inviteToken?: string | null;
  deepLink: string;
  alreadyJoined: boolean;
  status: GroupInvitationStatus;
  state?: GroupInviteState;
}): GroupInvitationSystemAction {
  const {
    groupId,
    groupName,
    groupAvatarUrl = null,
    memberCount,
    inviteToken = null,
    deepLink,
    alreadyJoined,
    status,
    state,
  } = params;
  const canOpen =
    status !== "DELETED" && (alreadyJoined || status === "ACTIVE");
  return {
    type: "GROUP_INVITATION",
    groupId,
    groupName,
    groupAvatarUrl,
    memberCount,
    inviteToken,
    deepLink,
    alreadyJoined,
    status,
    ...(state ? { state } : {}),
    canOpen,
  };
}

/**
 * The structured invitation object a COMMUNITY_INVITE / GROUP_INVITE row
 * carries. `type` is the discriminator the client switches on, exactly as
 * `content.call.callType` is for a call row.
 */
export type InvitationCard =
  | CommunityInvitationSystemAction
  | GroupInvitationSystemAction;

/**
 * Build the `content` of an invitation message — the invitation equivalent of a
 * call row's `{ text, urls, files, call }`.
 *
 * `text` is the human-readable line (inbox preview, push body, and the fallback
 * any client that doesn't know the kind still renders); `invitation` is the
 * structured card. Same three base keys as every other message content so the
 * shared media/preview helpers keep working on it unchanged.
 *
 * Deliberately NOT a second source of truth: `invitation` is whatever
 * {@link buildCommunityInvitationAction} / {@link buildGroupInvitationAction}
 * returned, so the card is built by the same two functions on the send path and
 * on every historical read.
 */
export function buildInvitationContent(
  text: string,
  invitation: InvitationCard
): Record<string, unknown> {
  return { text, urls: [], files: [], invitation };
}

/**
 * Read the invitation card off a stored/wire message's `content`. Returns
 * `undefined` for a legacy row written before invitations carried
 * `content.invitation` (those are re-stamped at read time from `systemData`).
 */
export function readInvitationContent(
  content: unknown
): InvitationCard | undefined {
  const invitation = (content as { invitation?: unknown } | null)?.invitation;
  return invitation && typeof invitation === "object"
    ? (invitation as InvitationCard)
    : undefined;
}

export interface ChatMessageEventInput {
  id: string;
  clientMessageId?: string | null;
  roomId: string;
  conversationType: ConversationKind;
  senderId: string;
  senderName?: string | null;
  senderAvatar?: string | null;
  senderRole?: string | null;
  receiverId?: string | null;
  messageType: string;
  content: unknown;
  parentMessageId?: string | null;
  quoteData?: unknown;
  reactions?: unknown[];
  isForwarded?: boolean;
  isDeleted?: boolean;
  deletedType?: string;
  /** epoch ms, 0 = never edited */
  editedAt?: number;
  /** epoch ms client compose time (display), 0 = unknown (§5.1 two timestamps) */
  clientTs?: number;
  /** epoch ms server-authoritative time (== sentAt/createdAt) */
  serverTs: number;
  sequenceNumber: number;
  /** Per-room CHANGE cursor. Required by `messages:catchup`'s `sinceRevision`, which had no way
   *  to advance because live events never carried it — community emitted it from the start. */
  revision?: number;
  /** Group lifecycle SYSTEM messages only (messageType=SYSTEM). */
  systemEvent?: string | null;
  systemData?: unknown;
  /** COMMUNITY_INVITE / GROUP_INVITE cards only — see {@link buildCommunityInvitationAction} / {@link buildGroupInvitationAction}. */
  systemAction?:
    | CommunityInvitationSystemAction
    | GroupInvitationSystemAction
    | null;
  countInUnread?: boolean | null;
  /**
   * PRIVATE auto-delete deadline (epoch ms), or null/omitted when the message
   * has no timer. MUST ride the live event, not just REST history: without it a
   * message sent while auto-delete is on renders with no countdown until the
   * client refetches, and then shows a countdown that is already expired.
   */
  autoDeleteAt?: number | null;
  /** True while an "After Viewing" message is waiting on the recipient's read receipt. */
  autoDeleteAfterView?: boolean;
}

/**
 * Pull a stored message's auto-delete stamp into the wire shape.
 *
 * One helper rather than four hand-rolled copies: every path that emits a live
 * `message:new`/`message:edited` (REST send, socket/gRPC send, forward, edit)
 * has to carry it, and the bug this fixes was exactly one of those paths
 * quietly not doing so.
 */
export function autoDeleteWireFields(row: unknown): {
  autoDeleteAt: number | null;
  autoDeleteAfterView: boolean;
} {
  const r = (row ?? {}) as {
    autoDeleteAt?: Date | string | number | null;
    autoDeleteAfterView?: boolean | null;
  };
  const raw = r.autoDeleteAt;
  let at: number | null = null;
  if (raw instanceof Date) at = raw.getTime();
  else if (typeof raw === "number") at = raw;
  else if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    at = Number.isFinite(parsed) ? parsed : null;
  }
  return {
    autoDeleteAt: at,
    autoDeleteAfterView: r.autoDeleteAfterView === true,
  };
}

/**
 * The ONE tombstone shape, stamped onto every serialized message so a client
 * reads deletion the same way on private, group and community.
 *
 * The three surfaces store deletion under three different column names
 * (`isDeleted`+`deletedAt` on private/group, `deletedForAll`+`deletedForAllAt`
 * on community), which forced clients to branch per conversation type. These
 * two fields are the normalized read: `deletedForEveryone` is the boolean the
 * client acts on, `deletedAt` is epoch ms (null when not deleted).
 *
 * ADDITIVE — the underlying columns are still serialized alongside, unchanged.
 *
 * Deleted messages replay through the `/changes` feed (which deliberately does
 * NOT filter tombstones); history pages continue to omit them, so an existing
 * client can never start rendering rows it did not render before.
 */
export function tombstoneWireFields(row: unknown): {
  deletedForEveryone: boolean;
  deletedAt: number | null;
} {
  const r = (row ?? {}) as {
    isDeleted?: boolean | null;
    deletedForAll?: boolean | null;
    deletedAt?: Date | string | number | null;
    deletedForAllAt?: Date | string | number | null;
  };
  const raw = r.deletedAt ?? r.deletedForAllAt ?? null;
  let at: number | null = null;
  if (raw instanceof Date) at = raw.getTime();
  else if (typeof raw === "number") at = raw;
  else if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    at = Number.isFinite(parsed) ? parsed : null;
  }
  return {
    deletedForEveryone: r.isDeleted === true || r.deletedForAll === true,
    deletedAt: at,
  };
}

export type DeleteConversationKind = ConversationKind | "COMMUNITY";

export interface DeletePayloadInput {
  conversationType: DeleteConversationKind;
  messageId: string;
  roomId: string;
  scope: "forMe" | "forEveryone";
  deletedBy: string;
  sequenceNumber?: number;
  deletedType?: string;
  /**
   * Tombstone metadata (§4). ADDITIVE and always emitted with a documented
   * default, so a replayed or out-of-order delete is a no-op on the client
   * instead of a rollback: `revision` is the room CHANGE cursor the delete was
   * stamped with (0 = unknown, treat as "apply"), `clientMessageId` lets a
   * client that only ever knew its optimistic row resolve identity, and
   * `deletedAt` is epoch ms.
   */
  revision?: number;
  clientMessageId?: string | null;
  /** epoch ms */
  deletedAt?: number;
}

/**
 * Build the canonical socket message:delete / community:message:deleted payload.
 * REST delete returns this exact object so REST == socket byte-for-byte.
 *   PRIVATE/GROUP: { messageId, conversationId, type, deletedBy, sequenceNumber }
 *   COMMUNITY:     { messageId, communityId, roomId, deleteType, deletedBy }
 */
export function buildDeletePayload(
  input: DeletePayloadInput
): Record<string, unknown> {
  // Tombstone metadata shared by both shapes — see DeletePayloadInput.
  const tombstone = {
    revision: input.revision ?? 0,
    clientMessageId: input.clientMessageId ?? null,
    deletedAt: input.deletedAt ?? 0,
    deletedForEveryone: input.scope === "forEveryone",
  };
  if (input.conversationType === "COMMUNITY") {
    return {
      messageId: input.messageId,
      communityId: input.roomId,
      roomId: input.roomId,
      deleteType: input.scope,
      deletedBy: input.deletedBy,
      ...tombstone,
    };
  }
  const base: Record<string, unknown> = {
    messageId: input.messageId,
    conversationId: input.roomId,
    type: input.scope,
    deletedBy: input.deletedBy,
    sequenceNumber: input.sequenceNumber ?? 0,
    ...tombstone,
  };
  if (input.conversationType === "GROUP") {
    base.deletedType = input.deletedType ?? "SELF_DELETE";
  }
  return base;
}

/**
 * Build the canonical `message:new` / `message:edited` payload. Field names match
 * the REST `ChatMessage` schema; legacy aliases preserved for V1 clients.
 */
export function buildChatMessageEvent(
  input: ChatMessageEventInput
): Record<string, unknown> {
  const messageType = normalizeMessageType(input.messageType);
  const content = input.content ?? null;
  const text =
    ((content as Record<string, unknown> | null)?.text as string) ?? "";
  return {
    // ── Canonical (REST ChatMessage names) ──────────────────────────────────
    id: input.id,
    clientMessageId: input.clientMessageId ?? "",
    roomId: input.roomId,
    conversationType: input.conversationType,
    senderId: input.senderId,
    senderName: input.senderName ?? "",
    senderAvatar: input.senderAvatar ?? "",
    senderRole: input.senderRole ?? "",
    receiverId:
      input.conversationType === "PRIVATE" ? (input.receiverId ?? "") : "",
    content,
    parentMessageId: input.parentMessageId ?? "",
    quoteData: buildCanonicalQuote(input.quoteData),
    reactions: input.reactions ?? [],
    ...(input.isForwarded ? { isForwarded: true } : {}),
    isDeleted: input.isDeleted ?? false,
    deletedType: input.deletedType ?? "",
    isEdited: (input.editedAt ?? 0) > 0,
    editedAt: input.editedAt ?? 0,
    clientTs: input.clientTs ?? 0,
    serverTs: input.serverTs,
    sequenceNumber: input.sequenceNumber,
    revision: input.revision ?? 0,
    countInUnread: input.countInUnread ?? true,
    // Auto-delete (PRIVATE). Always present so a client can clear a stale
    // countdown when a re-stamp removes the deadline, rather than only ever
    // learning about deadlines that exist.
    autoDeleteAt: input.autoDeleteAt ?? null,
    autoDeleteAfterView: input.autoDeleteAfterView ?? false,
    // Group lifecycle system messages (messageType=SYSTEM) carry structured data.
    ...(input.systemEvent ? { systemEvent: input.systemEvent } : {}),
    ...(input.systemData !== undefined ? { systemData: input.systemData } : {}),
    ...(input.systemAction ? { systemAction: input.systemAction } : {}),
    // ── V1-compat aliases (kept so existing clients keep working) ───────────
    messageId: input.id,
    conversationId: input.roomId,
    contentType: messageType,
    contentText: text,
    contentJson: safeStringify(content),
    sentAt: input.serverTs,
  };
}
