import { z } from "zod";

import {
  locationSchema,
  contactSchema,
  stickerSchema,
} from "./attachment.validator.js";
import {
  CHAT_TEXT_MAX_CHARS,
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
            objectKey: z.string().min(1).max(500).optional(),
            url: z.string().url().optional(),
            name: z.string().default(""),
            size: z.number().default(0),
            mime: z.string().default(""),
            width: z.number().nullish(),
            height: z.number().nullish(),
            durationMs: z.number().nonnegative().optional(),
          })
        )
        .default([]),
      location: locationSchema.optional(),
      contact: contactSchema.optional(),
      sticker: stickerSchema.optional(),
    }),
    messageType: z.enum([
      "TEXT",
      "IMAGE",
      "DOCUMENT",
      "VIDEO",
      "VOICE",
      "SYSTEM",
      "LOCATION",
      "CONTACT",
      "STICKER",
    ]),
    parentMessageId: z.string().nullish(),
    clientMessageId: z.string().nullish(),
  })
  .superRefine((val, ctx) => {
    enforceMediaLimits(val.messageType, val.content.files, ctx);
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

export const deleteGroupMessageSchema = z.object({
  messageId: z.string().min(4).max(100),
  roomId: z.string().min(4).max(100),
});

export const pinGroupMessageSchema = z.object({
  roomId: z.string().min(4).max(100),
  messageId: z.string().min(4).max(100),
});

export const forwardGroupMessageSchema = z.object({
  targetRoomId: z.string().min(4).max(150),
  clientMessageId: z.string().min(1).max(100).nullish(),
});
