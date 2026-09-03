import { z } from "zod";
import { CONTENT_TYPES } from "@aimess/constants";
import { isHttpUrl } from "@aimess/utils";

import {
  locationSchema,
  contactSchema,
  stickerSchema,
} from "./attachment.validator.js";
import {
  CHAT_TEXT_MAX_CHARS,
  CHAT_EMOJI_MAX_CHARS,
  enforceMediaLimits,
} from "../../constants/media-limits.js";
import { reportUserReasonSchema } from "../../lib/report-user.js";

const messageFileSchema = z.object({
  mediaId: z.string().min(1).max(100).optional(),
  objectKey: z.string().min(1).max(500).optional(),
  url: z.string().url().optional(),
  name: z.string().default(""),
  size: z.number().nonnegative().default(0),
  mime: z.string().default(""),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
  // Sender-uploaded poster frame for videos/animated GIFs. Was missing here, so zod
  // stripped it and receivers had to decode a frame out of the video over HTTP.
  thumbnailObjectKey: z.string().max(500).optional(),
  mediaBatchId: z.string().max(64).optional(),
  // §3.5: instant-preview metadata (image/video blur + voice waveform).
  blurhash: z.string().max(120).optional(),
  waveform: z.array(z.number()).max(2048).optional(),
});

/**
 * An http(s)-only URL.
 *
 * Zod's plain `.url()` only requires that `new URL(value)` succeeds — it applies
 * NO scheme constraint — so `javascript:alert(1)` and `data:text/html,…` both
 * pass it. These values are stored on messages and handed to clients that put
 * them in `href`, `src` and `window.open`, which makes an unconstrained URL
 * field stored XSS against every recipient; Android and iOS consume the same
 * stored values. Defined from the shared predicate in `@aimess/utils` so the
 * socket and REST paths cannot drift — the socket attachment schemas had no URL
 * validation at all.
 */
export const httpUrlSchema = z
  .string()
  .min(1)
  .max(3000)
  .refine(isHttpUrl, { message: "must be an http(s) URL" });

export const sendPrivateMessageSchema = z
  .object({
    roomId: z.string().min(5).max(300),
    /** @deprecated Accepted but IGNORED — the peer is resolved from the room. */
    receiverId: z.string().min(5).max(100).optional(),
    content: z.object({
      text: z.string().max(CHAT_TEXT_MAX_CHARS).default(""),
      urls: z.array(z.string().url()).default([]),
      files: z.array(messageFileSchema).default([]),
      location: locationSchema.optional(),
      contact: contactSchema.optional(),
      sticker: stickerSchema.optional(),
    }),
    // Single source of truth: @aimess/constants CONTENT_TYPES (UPPER-CASE).
    // Previously hand-typed here and missing AUDIO/GIF — see media-limits.ts,
    // which already enforces caps for both.
    messageType: z.enum(CONTENT_TYPES),
    parentMessageId: z.string().nullish(),
  })
  .superRefine((val, ctx) => {
    enforceMediaLimits(val.messageType, val.content.files, ctx);
  });

/**
 * REST send body for `POST /private/rooms/:roomId/messages`. roomId comes from
 * the path, so only the message fields live in the body. receiverId (the peer)
 * is still required — the private friendship gate needs both ids. clientMessageId
 * is optional (the orchestrator defaults it) but recommended for idempotency.
 */
export const sendPrivateMessageBodySchema = z
  .object({
    /** @deprecated Accepted but IGNORED — the peer is resolved from the room. */
    receiverId: z.string().min(5).max(100).optional(),
    content: z.object({
      text: z.string().max(CHAT_TEXT_MAX_CHARS).default(""),
      urls: z.array(z.string().url()).default([]),
      files: z.array(messageFileSchema).default([]),
      location: locationSchema.optional(),
      contact: contactSchema.optional(),
      sticker: stickerSchema.optional(),
    }),
    messageType: z.enum(CONTENT_TYPES),
    parentMessageId: z.string().nullish(),
    clientMessageId: z.string().min(1).max(100).nullish(),
    clientTs: z.number().nonnegative().nullish(),
  })
  .superRefine((val, ctx) => {
    enforceMediaLimits(val.messageType, val.content.files, ctx);
  });

/**
 * REST body for `POST /private/rooms/:roomId/read` (mark-read up to a message).
 * roomId comes from the path; the caller id from the access token — so the body
 * carries only the read high-water mark.
 */
export const markReadBodySchema = z.object({
  upToMessageId: z.string().min(1).max(150),
});

export const reactMessageSchema = z.object({
  roomId: z.string().min(4).max(100),
  messageId: z.string().min(4).max(100),
  reactions: z.record(
    z.string(),
    z.array(
      z.object({
        userId: z.string(),
        userName: z.string().min(1),
        avatar: z.string().default(""),
        memberId: z.string().default(""),
      })
    )
  ),
});

/**
 * REST body for `POST /private/rooms/:roomId/messages/:messageId/reactions`
 * (add a reaction — idempotent toggle-ON). roomId/messageId come from the path,
 * the caller from the token, so only the emoji lives in the body. Emoji is capped
 * 1–CHAT_EMOJI_MAX_CHARS chars to match the socket reaction contract.
 */
export const reactionBodySchema = z.object({
  emoji: z.string().min(1).max(CHAT_EMOJI_MAX_CHARS),
});

/**
 * URL-param validator for `DELETE …/reactions/:emoji` (remove a reaction —
 * idempotent toggle-OFF). Express already URL-decodes the path param; this just
 * enforces the same cap as the POST body.
 */
export const reactionParamSchema = z.object({
  emoji: z.string().min(1).max(CHAT_EMOJI_MAX_CHARS),
});

export const pinMessageSchema = z.object({
  roomId: z.string().min(4).max(150),
  messageId: z.string().min(4).max(100),
});

export const unpinMessageSchema = z.object({
  roomId: z.string().min(4).max(150),
  messageId: z.string().min(4).max(100),
  pinId: z.string().min(4).max(100),
});

export const deleteMessageQuerySchema = z.object({
  type: z.enum(["forMe", "forEveryone"]),
});

export const getMessagesSchema = z.object({
  roomId: z.string().min(5).max(300),
  cursor: z.string().nullish(),
  limit: z.coerce.number().min(1).max(100).default(30),
});

export const forwardMessageSchema = z.object({
  targetRoomId: z.string().min(4).max(150),
  /** @deprecated Accepted but IGNORED — the peer is resolved from the TARGET room. */
  receiverId: z.string().min(4).max(100).optional(),
  clientMessageId: z.string().min(1).max(100).nullish(),
});

/**
 * A text edit carries TEXT ONLY.
 *
 * `files` used to be accepted here and written to the message row wholesale,
 * with none of the verification the SEND path performs: no scan-status check,
 * no "the registry says this object belongs to the sender", no "…and to this
 * room". On every read the stored entries are re-signed unconditionally, so any
 * participant of any room could edit one of their own text messages, put
 * someone else's object key in `files[0].objectKey`, and read back a freshly
 * presigned URL for it — bypassing media-service's ownership and membership
 * policy entirely, re-granting access to attachments after leaving or being
 * banned from the room they came from, and re-hosting objects whose scan
 * verdict the send gate would have refused.
 *
 * Both edit paths already refuse anything but a TEXT message, so a legitimate
 * edit never carried attachments; the field existed only as the write
 * primitive. Dropping it is the fix — a stricter attachment check here would
 * still leave a way to attach on a path that has no reason to.
 *
 * `.strip()` (zod's default for unknown keys) means an older client that still
 * sends `files` is not rejected: the field is discarded and the edit succeeds
 * as a text edit.
 */
export const editMessageSchema = z.object({
  content: z.object({
    text: z.string().min(1).max(CHAT_TEXT_MAX_CHARS),
    urls: z.array(httpUrlSchema).default([]),
  }),
});

export const muteRoomSchema = z.object({
  muteUntil: z.string().datetime().nullish(),
});

/**
 * Auto-delete (disappearing messages). `ttlSeconds` is required for TIMER and
 * ignored otherwise; the bounds live in `lib/auto-delete.ts` and are re-checked
 * there so the socket/gRPC paths can't bypass them.
 */
export const autoDeleteSchema = z.object({
  mode: z.enum(["OFF", "TIMER", "AFTER_VIEWING"]),
  ttlSeconds: z.number().int().positive().nullish(),
});

/**
 * Free text, same rule as reportPrivateUserSchema / community's
 * createReportSchema — NOT a closed enum. The shared report dialog sends
 * OFFENSIVE_LANGUAGE / INAPPROPRIATE_CONTENT / SCAM_OR_FRAUD / IMPERSONATION,
 * none of which the old enum here allowed, so five of its six reasons 400'd.
 * backoffice-service's normalizeReportReason canonicalizes whatever arrives.
 *
 * `roomId` is optional and purely a cross-check: the service resolves the real
 * room from the message and rejects a mismatch, so a client cannot report a
 * message while claiming it belongs to another conversation.
 */
export const reportMessageSchema = z.object({
  reason: reportUserReasonSchema,
  description: z.string().max(1000).default(""),
  roomId: z.string().min(5).max(300).optional(),
});

/**
 * Report the OTHER participant of a private room — the private-chat counterpart
 * of group's reportMemberSchema and community's createReportSchema. Reason rule
 * is the shared one (see lib/report-user.ts) so all three surfaces accept the
 * same vocabulary from the same dialog.
 */
export const reportPrivateUserSchema = z.object({
  userId: z.string().min(5).max(100),
  reason: reportUserReasonSchema,
  description: z.string().max(1000).default(""),
});
