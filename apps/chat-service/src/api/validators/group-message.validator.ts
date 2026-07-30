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

export const sendGroupMessageSchema = z
  .object({
    roomId: z.string().min(5).max(100),
    content: z.object({
      text: z.string().max(CHAT_TEXT_MAX_CHARS).default(""),
      urls: z.array(z.string()).default([]),
      files: z
        .array(
          z.object({
            mediaId: z.string().min(1).max(100).optional(),
            objectKey: z.string().min(1).max(500).optional(),
            url: z.string().url().optional(),
            name: z.string().default(""),
            size: z.number().default(0),
            mime: z.string().default(""),
            width: z.number().nullish(),
            height: z.number().nullish(),
            durationMs: z.number().nonnegative().optional(),
            // Sender-uploaded poster frame for videos/animated GIFs — zod strips
            // unknown keys, so leaving it out dropped it before persistence.
            thumbnailObjectKey: z.string().max(500).optional(),
          })
        )
        .default([]),
      location: locationSchema.optional(),
      contact: contactSchema.optional(),
      sticker: stickerSchema.optional(),
    }),
    // Single source of truth: @aimess/constants CONTENT_TYPES (UPPER-CASE).
    messageType: z.enum(CONTENT_TYPES),
    parentMessageId: z.string().nullish(),
    clientMessageId: z.string().nullish(),
  })
  .superRefine((val, ctx) => {
    enforceMediaLimits(val.messageType, val.content.files, ctx);
  });

/**
 * REST send body for `POST /groups/:roomId/messages`. roomId comes from the
 * path, so only the message fields live in the body. clientMessageId is optional
 * (the orchestrator defaults it) but recommended for idempotency.
 */
export const sendGroupMessageBodySchema = z
  .object({
    content: z.object({
      text: z.string().max(CHAT_TEXT_MAX_CHARS).default(""),
      urls: z.array(z.string()).default([]),
      files: z
        .array(
          z.object({
            mediaId: z.string().min(1).max(100).optional(),
            objectKey: z.string().min(1).max(500).optional(),
            url: z.string().url().optional(),
            name: z.string().default(""),
            size: z.number().default(0),
            mime: z.string().default(""),
            width: z.number().nullish(),
            height: z.number().nullish(),
            durationMs: z.number().nonnegative().optional(),
            // Sender-uploaded poster frame for videos/animated GIFs — zod strips
            // unknown keys, so leaving it out dropped it before persistence.
            thumbnailObjectKey: z.string().max(500).optional(),
          })
        )
        .default([]),
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
 * REST body for `POST /groups/:roomId/read` (mark-read up to a message). roomId
 * comes from the path; the caller id from the access token — so the body carries
 * only the read high-water mark.
 */
export const markGroupReadBodySchema = z.object({
  upToMessageId: z.string().min(1).max(150),
});

export const editGroupMessageSchema = z.object({
  content: z.object({
    text: z.string().min(1).max(CHAT_TEXT_MAX_CHARS),
    urls: z.array(z.string()).default([]),
    files: z.array(z.unknown()).default([]),
  }),
});

export const reactGroupMessageSchema = z.object({
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
 * REST body for `POST /groups/:roomId/messages/:messageId/reactions` (add a
 * reaction — idempotent toggle-ON). roomId/messageId come from the path, the
 * caller from the token, so only the emoji lives in the body. Emoji is capped
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

export const deleteGroupMessageSchema = z.object({
  messageId: z.string().min(4).max(100),
  roomId: z.string().min(4).max(100),
  // Optional delete scope, mirroring private/community. ABSENT === "forEveryone"
  // so every existing client (which sends no `type`) keeps its current behavior.
  type: z.enum(["forMe", "forEveryone"]).optional(),
});

export const pinGroupMessageSchema = z.object({
  roomId: z.string().min(4).max(100),
  messageId: z.string().min(4).max(100),
});

export const forwardGroupMessageSchema = z.object({
  targetRoomId: z.string().min(4).max(150),
  clientMessageId: z.string().min(1).max(100).nullish(),
});
