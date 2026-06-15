import { z } from "zod";
import { CONTENT_TYPES } from "@aimess/constants";

import {
  locationSchema,
  contactSchema,
  stickerSchema,
} from "./attachment.validator.js";
import {
  CHAT_TEXT_MAX_CHARS,
  enforceMediaLimits,
} from "../../constants/media-limits.js";

const messageFileSchema = z.object({
  objectKey: z.string().min(1).max(500).optional(),
  url: z.string().url().optional(),
  name: z.string().default(""),
  size: z.number().nonnegative().default(0),
  mime: z.string().default(""),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
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

export const markReadSchema = z.object({
  receiverId: z.string().min(4).max(150),
  roomId: z.string().min(4).max(150),
  lastMessageId: z.string().min(4).max(150),
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
