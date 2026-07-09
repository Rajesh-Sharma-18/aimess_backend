import { GoneError, NotFoundError } from "@aimess/errors";

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
      err.messageKey === "CHAT_MESSAGE_NOT_FOUND")
  );
}

export function buildUnavailableContext(params: {
  messageId: string;
  roomId: string;
  conversationType: MessageConversationType;
}): MessageContextResult {
  return {
    messageId: params.messageId,
    roomId: params.roomId,
    conversationType: params.conversationType,
    isAvailable: false,
    error: { code: "MESSAGE_NOT_FOUND", message: "Message doesn't exist" },
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
