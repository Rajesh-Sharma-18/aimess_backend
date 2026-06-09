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
  senderName: string;
  messageType: string;
  preview: string;
  isDeleted: boolean;
}

/**
 * Normalize any stored quoteData shape to the canonical reply snapshot.
 * Tolerates the two legacy shapes so old persisted rows still render:
 *   - private legacy: { message, senderName }
 *   - group   legacy: { text, senderId, senderName, messageType, deletedForAll }
 */
export function buildCanonicalQuote(raw: unknown): CanonicalQuote | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  const preview =
    (q.preview as string) ?? (q.message as string) ?? (q.text as string) ?? "";
  return {
    messageId: (q.messageId as string) ?? (q.parentMessageId as string) ?? "",
    senderId: (q.senderId as string) ?? "",
    senderName: (q.senderName as string) ?? "",
    messageType: q.messageType
      ? normalizeMessageType(q.messageType as string)
      : "",
    preview: typeof preview === "string" ? preview : "",
    isDeleted: Boolean(q.isDeleted ?? q.deletedForAll ?? false),
  };
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  users: Array<{ userId: string; displayName: string; avatar: string }>;
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
          avatar: (o.avatar as string) ?? "",
        };
      }),
    });
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
    messageType,
    content,
    parentMessageId: input.parentMessageId ?? "",
    quoteData: buildCanonicalQuote(input.quoteData),
    reactions: input.reactions ?? [],
    ...(input.isForwarded ? { isForwarded: true } : {}),
    isDeleted: input.isDeleted ?? false,
    deletedType: input.deletedType ?? "",
    editedAt: input.editedAt ?? 0,
    clientTs: input.clientTs ?? 0,
    serverTs: input.serverTs,
    sequenceNumber: input.sequenceNumber,
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
