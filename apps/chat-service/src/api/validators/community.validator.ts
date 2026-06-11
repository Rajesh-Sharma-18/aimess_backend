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

export const sendCommunityMessageSchema = z
  .object({
    roomId: z.string().min(5).max(50),
    message: z.string().max(CHAT_TEXT_MAX_CHARS).default(""),
    messageType: z.enum([
      "text",
      "image",
      "video",
      "voice",
      "audio",
      "document",
      "gif",
      "location",
      "contact",
      "sticker",
      "custom",
    ]),
    parentMessageId: z.string().nullish(),
    clientMessageId: z.string().optional(),
    username: z.string().min(5).max(50),
    displayname: z.string().nullish(),
    avatar: z.string().max(3000).default(""),
    media: z
      .object({
        files: z.array(
          z.object({
            url: z.string().url(),
            key: z.string(),
            mime: z.string(),
            size: z.number(),
            width: z.number().optional(),
            height: z.number().optional(),
            durationMs: z.number().nonnegative().optional(),
          })
        ),
      })
      .optional(),
    location: locationSchema.optional(),
    contact: contactSchema.optional(),
    sticker: stickerSchema.optional(),
  })
  .superRefine((val, ctx) => {
    enforceMediaLimits(val.messageType, val.media?.files, ctx);
  });

export const editCommunityMessageSchema = z.object({
  // communityId is required so the edit broadcast reaches the right /community
  // room (clients join community:<communityId>, mirroring the send path).
  communityId: z.string().min(1),
  content: z.object({
    text: z.string().min(1).max(CHAT_TEXT_MAX_CHARS),
  }),
});

export const reactCommunityMessageSchema = z.object({
  roomId: z.string().min(4).max(50),
  messageId: z.string().min(4).max(50),
  reactions: z.record(
    z.string(),
    z.array(
      z.object({
        userId: z.string(),
        userName: z.string().min(1),
        avatar: z.string().default(""),
      })
    )
  ),
});

export const reactCommunityMessageBodySchema = z.object({
  communityId: z.string().min(1),
  emoji: z.string().min(1).max(10),
});

export const reportMessageSchema = z.object({
  roomId: z.string().min(10).max(300),
  messageId: z.string().min(10).max(300),
  reportReason: z.string().min(1).max(200).trim(),
  reportDescription: z.string().max(300).trim().default(""),
});

export const searchRoomsSchema = z.object({
  query: z.string().min(1).max(100),
});

export const pinCommunityMessageSchema = z.object({
  communityId: z.string().optional(),
});

export const unpinCommunityMessageSchema = z.object({
  communityId: z.string().optional(),
  messageId: z.string().min(1),
  // communityId: z.string().min(1),
});

export const unpinCommunityMessageQuerySchema = z.object({
  communityId: z.string().min(1),
});
