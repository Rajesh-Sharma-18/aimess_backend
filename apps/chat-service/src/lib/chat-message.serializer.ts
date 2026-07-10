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

export type ConversationKind = "PRIVATE" | "GROUP";

/** Canonical message type is UPPER-CASE everywhere (§1 single casing). */
export function normalizeMessageType(type: string | null | undefined): string {
  const t = String(type ?? "").trim();
  return t ? t.toUpperCase() : "TEXT";
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
  durationMs: number;
  attachmentCount: number;
}

/** WhatsApp-style reply preview text — the SINGLE rule set for every reply
 *  snapshot, distinct from {@link convertMessageToPreview}'s list/push preview
 *  wording (that one keeps its own emoji/labels for the conversation list). */
export function buildReplyPreviewText(
  messageType: string,
  content: unknown,
  attachmentCount: number
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
      return attachmentCount > 1 ? `📷 ${attachmentCount} Photos` : "📷 Photo";
    case "VIDEO":
      return "🎥 Video";
    case "VOICE":
      return "🎤 Voice message";
    case "AUDIO":
      return "🎵 Audio";
    case "DOCUMENT":
      return fileName ? `📄 ${fileName}` : "📄 Document";
    case "GIF":
      return "GIF";
    case "STICKER":
      return "Sticker";
    case "CONTACT":
      return "Contact";
    case "LOCATION":
      return "Location";
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
export function buildCanonicalQuote(raw: unknown): CanonicalQuote | null {
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
    preview: isDeleted
      ? "Message deleted"
      : typeof storedPreview === "string"
        ? storedPreview
        : "",
    isDeleted,
    thumbnail:
      typeof q.thumbnail === "string" && q.thumbnail ? q.thumbnail : null,
    mimeType: typeof q.mimeType === "string" && q.mimeType ? q.mimeType : null,
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
  const durationMs = first?.durationMs;
  const attachmentCount = input.attachmentCountOverride ?? files.length;
  return {
    messageId: input.messageId,
    senderId: input.senderId,
    senderName: input.senderName,
    messageType: normalizeMessageType(input.messageType),
    preview: buildReplyPreviewText(
      input.messageType,
      input.content,
      attachmentCount
    ),
    isDeleted: Boolean(input.isDeleted),
    thumbnail: thumbnailKey || null,
    mimeType: mimeType || null,
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
 * input is not mutated). Absent → append the canonical reactor object; present →
 * remove it, pruning the emoji bucket when it empties. Carried-over entries are
 * normalized to the canonical object shape, so the persisted result is always
 * well-formed regardless of how legacy rows were written.
 */
export function toggleStoredReaction(
  raw: unknown,
  userId: string,
  emoji: string
): Record<string, StoredReactor[]> {
  const out: Record<string, StoredReactor[]> = {};
  if (raw && typeof raw === "object") {
    for (const [e, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const entries = list.map(normalizeReactor).filter((r) => r.userId);
      if (entries.length) out[e] = entries;
    }
  }
  const bucket = out[emoji] ?? [];
  const idx = bucket.findIndex((r) => r.userId === userId);
  if (idx !== -1) bucket.splice(idx, 1);
  else bucket.push({ userId, userName: "", avatar: "", memberId: "" });
  if (bucket.length === 0) delete out[emoji];
  else out[emoji] = bucket;
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
  /** Group lifecycle SYSTEM messages only (messageType=SYSTEM). */
  systemEvent?: string | null;
  systemData?: unknown;
  countInUnread?: boolean | null;
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
  if (input.conversationType === "COMMUNITY") {
    return {
      messageId: input.messageId,
      communityId: input.roomId,
      roomId: input.roomId,
      deleteType: input.scope,
      deletedBy: input.deletedBy,
    };
  }
  const base: Record<string, unknown> = {
    messageId: input.messageId,
    conversationId: input.roomId,
    type: input.scope,
    deletedBy: input.deletedBy,
    sequenceNumber: input.sequenceNumber ?? 0,
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
      input.conversationType === "GROUP" ? "" : (input.receiverId ?? ""),
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
    countInUnread: input.countInUnread ?? true,
    // Group lifecycle system messages (messageType=SYSTEM) carry structured data.
    ...(input.systemEvent ? { systemEvent: input.systemEvent } : {}),
    ...(input.systemData !== undefined ? { systemData: input.systemData } : {}),
    // ── V1-compat aliases (kept so existing clients keep working) ───────────
    messageId: input.id,
    conversationId: input.roomId,
    contentType: messageType,
    contentText: text,
    contentJson: safeStringify(content),
    sentAt: input.serverTs,
  };
}
