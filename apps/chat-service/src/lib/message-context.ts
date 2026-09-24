import { ForbiddenError, GoneError, NotFoundError } from "@aimess/errors";

/**
 * Shared response-shaping for the "message navigation context" feature
 * (reply-tap, pinned-message-tap, search-result-tap, shared-message deep
 * link, notification deep link — any caller that has a `{ conversationType,
 * roomId, messageId }` triple and needs to locate + scroll to that message).
 *
 * Used by the unified `MessageContextController` (single cross-type API) AND
 * by the legacy per-conversation-type `.../messages/:messageId/context`
 * controllers, so the anchor/cursor shape and the "is this a content-not-found
 * result vs. a real access error" rule live in exactly one place.
 */

export type MessageConversationType = "PRIVATE" | "GROUP" | "COMMUNITY";

export interface MessageContextAnchor {
  /** Room-local monotonic sequence number (private/group only — community
   *  history has no seq column). Feeds `?before_seq=`/`?after_seq=`. */
  sequenceNumber?: number;
  /** Compound `"<createdAt_ms>_<messageId>"` cursor. Feeds `?before_ts=`. */
  beforeCursor: string;
  /** Same value as `beforeCursor` (reserved for `?after_ts=`). */
  afterCursor: string;
}

export interface MessageContextResult {
  messageId: string;
  roomId: string;
  conversationType: MessageConversationType;
  isAvailable: boolean;
  anchor?: MessageContextAnchor;
  error?: { code: string; message: string };
}

/**
 * Why a message cannot be navigated to. Two DIFFERENT answers, deliberately not
 * one: `MESSAGE_BEFORE_JOIN` means the caller was not in the room yet and never
 * had access, `MESSAGE_NOT_FOUND` means it is gone (deleted for everyone, hidden
 * for them, expired, or never existed). Clients say different things for each,
 * so collapsing them tells the reader something untrue.
 *
 * Neither carries any of the message's own content — the code IS the answer.
 */
export const MESSAGE_CONTEXT_REASON = {
  notFound: "MESSAGE_NOT_FOUND",
  beforeJoin: "MESSAGE_BEFORE_JOIN",
} as const;

export type MessageContextReason =
  (typeof MESSAGE_CONTEXT_REASON)[keyof typeof MESSAGE_CONTEXT_REASON];

/** The thrown-error key the services raise for the before-join refusal. */
export const MESSAGE_BEFORE_JOIN_KEY = "CHAT_MESSAGE_BEFORE_JOIN";

/** True when the error is the membership-boundary refusal (not a generic 403). */
export function isBeforeJoinError(err: unknown): boolean {
  return (
    err instanceof ForbiddenError && err.messageKey === MESSAGE_BEFORE_JOIN_KEY
  );
}

/**
 * True when a thrown error represents a CONTENT-level result (message missing
 * or deleted) rather than an ACCESS-level failure (not a participant/member,
 * room doesn't exist). Content-level results are surfaced as `200
 * isAvailable:false`; access failures propagate as normal 403/404 so a caller
 * can't fish for the existence of a message in a room they can't read.
 */
export function isMessageContentError(err: unknown): boolean {
  return (
    err instanceof GoneError ||
    (err instanceof NotFoundError &&
      err.messageKey === "CHAT_MESSAGE_NOT_FOUND") ||
    // The membership-boundary refusal is an ANSWER about the target, not a
    // failure to answer: the caller may read the room, just not this far back.
    // Surfaced as 200 + isAvailable:false with its own code, like the others.
    isBeforeJoinError(err)
  );
}

/** The reason code for an error {@link isMessageContentError} accepted. */
export function messageContextReasonFor(err: unknown): MessageContextReason {
  return isBeforeJoinError(err)
    ? MESSAGE_CONTEXT_REASON.beforeJoin
    : MESSAGE_CONTEXT_REASON.notFound;
}

export function buildUnavailableContext(params: {
  messageId: string;
  roomId: string;
  conversationType: MessageConversationType;
  /** Defaults to `MESSAGE_NOT_FOUND` — the answer every caller gave before the
   *  before-join reason existed, so existing clients read an unchanged shape. */
  reason?: MessageContextReason;
}): MessageContextResult {
  const reason = params.reason ?? MESSAGE_CONTEXT_REASON.notFound;
  return {
    messageId: params.messageId,
    roomId: params.roomId,
    conversationType: params.conversationType,
    isAvailable: false,
    error: {
      code: reason,
      message:
        reason === MESSAGE_CONTEXT_REASON.beforeJoin
          ? "Message is outside your history"
          : "Message doesn't exist",
    },
  };
}

export function buildAvailableContext(params: {
  messageId: string;
  roomId: string;
  conversationType: MessageConversationType;
  /** Present for private/group; omitted for community. */
  sequenceNumber?: number | null;
  createdAt: Date | number;
}): MessageContextResult {
  const ms =
    params.createdAt instanceof Date
      ? params.createdAt.getTime()
      : Number(params.createdAt);
  const compoundCursor = `${ms}_${params.messageId}`;

  return {
    messageId: params.messageId,
    roomId: params.roomId,
    conversationType: params.conversationType,
    isAvailable: true,
    anchor: {
      ...(params.sequenceNumber != null
        ? { sequenceNumber: params.sequenceNumber }
        : {}),
      beforeCursor: compoundCursor,
      afterCursor: compoundCursor,
    },
  };
}
