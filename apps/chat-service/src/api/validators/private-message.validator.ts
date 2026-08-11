import { z } from "zod";
import { CONTENT_TYPES } from "@aimess/constants";

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

export const sendPrivateMessageSchema = z
  .object({
    roomId: z.string().min(5).max(300),
    receiverId: z.string().min(5).max(100),
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
    receiverId: z.string().min(5).max(100),
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
  receiverId: z.string().min(4).max(100),
  clientMessageId: z.string().min(1).max(100).nullish(),
});

export const editMessageSchema = z.object({
  content: z.object({
    text: z.string().min(1).max(CHAT_TEXT_MAX_CHARS),
    urls: z.array(z.string().url()).default([]),
    files: z.array(messageFileSchema).default([]),
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

export const reportMessageSchema = z.object({
  reason: z.enum([
    "SPAM",
    "HARASSMENT",
    "HATE_SPEECH",
    "NUDITY",
    "VIOLENCE",
    "SCAM",
    "OTHER",
  ]),
  description: z.string().max(1000).default(""),
});
