import { BadRequestError } from "@aimess/errors";
import { isCallContentType, isInviteContentType } from "@aimess/constants";

import {
  normalizeMessageType,
  type ConversationKind,
} from "./chat-message.serializer.js";

/** A source message the caller may read, normalized across the three stores. */
export interface ForwardSource {
  messageId: string;
  roomId: string;
  conversationType: ConversationKind;
  senderId: string;
  /** Row's denormalized name; "" when the store has none (private). */
  senderName: string;
  createdAtMs: number;
  contentType: string;
  content: {
    text: string;
    urls: string[];
    files: Array<Record<string, unknown>>;
    location?: Record<string, unknown>;
    contact?: Record<string, unknown>;
    sticker?: Record<string, unknown>;
  };
  /** The source's own provenance when it is itself a forward. */
  forwardData: Record<string, unknown> | null;
}

const NOT_FORWARDABLE = new Set(["SYSTEM", "CALL"]);

export function assertForwardable(row: {
  messageType?: string | null;
  systemEvent?: string | null;
  systemMessageType?: string | null;
  autoDeleteAfterView?: boolean | null;
}): void {
  const type = normalizeMessageType(row.messageType);
  if (
    NOT_FORWARDABLE.has(type) ||
    isCallContentType(type) ||
    isInviteContentType(type) ||
    row.systemEvent ||
    row.systemMessageType ||
    row.autoDeleteAfterView === true
  ) {
    throw new BadRequestError("CHAT_FORWARD_NOT_ALLOWED");
  }
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Private/group `content` blob → normalized content. */
export function directForwardContent(raw: unknown): ForwardSource["content"] {
  const c = obj(raw) ?? {};
  return {
    text: typeof c.text === "string" ? c.text : "",
    urls: Array.isArray(c.urls) ? (c.urls as string[]) : [],
    files: Array.isArray(c.files)
      ? (c.files as Array<Record<string, unknown>>)
      : [],
    ...(obj(c.location) ? { location: obj(c.location) } : {}),
    ...(obj(c.contact) ? { contact: obj(c.contact) } : {}),
    ...(obj(c.sticker) ? { sticker: obj(c.sticker) } : {}),
  };
}

const STRUCTURED = ["location", "contact", "sticker"] as const;

/** Community `message` + typed `attachments[]` → normalized content. */
export function communityForwardContent(
  message: string | null | undefined,
  attachments: unknown
): ForwardSource["content"] {
  const list = Array.isArray(attachments)
    ? (attachments as Array<Record<string, unknown>>)
    : [];
  const content: ForwardSource["content"] = {
    text: message ?? "",
    urls: [],
    files: list.filter(
      (a) => !STRUCTURED.includes(a?.type as (typeof STRUCTURED)[number])
    ),
  };
  for (const kind of STRUCTURED) {
    const hit = list.find((a) => a?.type === kind);
    if (hit) {
      const { type: _type, ...rest } = hit;
      void _type;
      content[kind] = rest;
    }
  }
  return content;
}

/** Normalized content → community `attachments[]` (send-path priority order). */
export function toCommunityAttachments(
  content: ForwardSource["content"]
): Array<Record<string, unknown>> | undefined {
  if (content.files.length) return content.files;
  for (const kind of STRUCTURED) {
    if (content[kind]) return [{ type: kind, ...content[kind] }];
  }
  return undefined;
}

/** Normalized content → private/group `content` blob. */
export function toDirectContent(
  content: ForwardSource["content"]
): Record<string, unknown> & { text: string } {
  return {
    text: content.text,
    ...(content.urls.length ? { urls: content.urls } : {}),
    files: content.files,
    ...(content.location ? { location: content.location } : {}),
    ...(content.contact ? { contact: content.contact } : {}),
    ...(content.sticker ? { sticker: content.sticker } : {}),
  };
}

/** Every uploaded object key the content references (external URLs excluded). */
export function forwardObjectKeys(content: ForwardSource["content"]): string[] {
  const keys = new Set<string>();
  for (const f of [...content.files, content.sticker]) {
    for (const k of [f?.objectKey, f?.thumbnailObjectKey]) {
      if (typeof k === "string" && k && !/^https?:\/\//i.test(k)) keys.add(k);
    }
  }
  return [...keys];
}

function toEpochMs(v: unknown): number {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  const parsed = Date.parse(String(v ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Contract `forwardData`; a forward of a forward keeps the FIRST origin. */
export function buildForwardData(
  src: ForwardSource,
  resolveName: (userId: string) => string
): Record<string, unknown> {
  const prev = src.forwardData;
  if (prev && typeof prev.originalMessageId === "string") {
    // Legacy per-kind forwards were same-kind only and stored ISO time + no name.
    const senderId = String(prev.originalSenderId ?? "");
    return {
      originalMessageId: prev.originalMessageId,
      originalRoomId: String(prev.originalRoomId ?? ""),
      originalConversationType:
        prev.originalConversationType ?? src.conversationType,
      originalSenderId: senderId,
      originalSenderName:
        (prev.originalSenderName as string) || resolveName(senderId),
      originalCreatedAt: toEpochMs(prev.originalCreatedAt),
      originalContentType: normalizeMessageType(
        (prev.originalContentType ??
          prev.originalMessageType ??
          src.contentType) as string
      ),
    };
  }
  return {
    originalMessageId: src.messageId,
    originalRoomId: src.roomId,
    originalConversationType: src.conversationType,
    originalSenderId: src.senderId,
    originalSenderName: src.senderName || resolveName(src.senderId),
    originalCreatedAt: src.createdAtMs,
    originalContentType: src.contentType,
  };
}
