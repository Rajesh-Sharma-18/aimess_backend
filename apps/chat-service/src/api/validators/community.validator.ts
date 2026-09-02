import { z } from "zod";
import { isCommunityContentType } from "@aimess/constants";

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
    // Single source of truth: derived from @aimess/constants CONTENT_TYPES. The
    // community path uses the lower-case spelling (+ "custom"); accept
    // case-insensitively and normalize to lower-case for storage parity with
    // pre-existing docs.
    messageType: z
      .string()
      .min(1)
      .transform((v) => v.toLowerCase())
      .refine(isCommunityContentType, {
        message: "Unsupported community messageType",
      }),
    parentMessageId: z.string().nullish(),
    clientMessageId: z.string().optional(),
    username: z.string().min(5).max(50),
    displayname: z.string().nullish(),
    avatar: z.string().max(3000).default(""),
    media: z
      .object({
        files: z.array(
          z.object({
            mediaId: z.string().min(1).max(100).optional(),
            url: z.string().url(),
            key: z.string(),
            mime: z.string(),
            size: z.number(),
            width: z.number().optional(),
            height: z.number().optional(),
            durationMs: z.number().nonnegative().optional(),
            // Sender-uploaded poster frame for videos/animated GIFs — zod strips
            // unknown keys, so leaving it out dropped it before persistence.
            thumbnailObjectKey: z.string().max(500).optional(),
            mediaBatchId: z.string().max(64).optional(),
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

/**
 * REST send body for `POST /community/rooms/:roomId/messages`. roomId (the chat
 * GeneralRoom id) comes from the path; communityId (the community-service
 * Community.id, used for the broadcast + activity bump) is required in the body.
 * messageType accepts the community lower-case spelling (+ "custom"). attachments
 * mirror the gRPC handler's attachmentsJson (media.files / location / contact /
 * sticker); the controller flattens them into the service attachments array.
 */
export const sendCommunityMessageBodySchema = z
  .object({
    communityId: z.string().min(1),
    /** Display name of the community — forwarded to the push notification title. */
    communityName: z.string().max(150).optional(),
    message: z.string().max(CHAT_TEXT_MAX_CHARS).default(""),
    messageType: z
      .string()
      .min(1)
      .transform((v) => v.toLowerCase())
      .refine(isCommunityContentType, {
        message: "Unsupported community messageType",
      }),
    parentMessageId: z.string().nullish(),
    clientMessageId: z.string().min(1).max(100).nullish(),
    media: z
      .object({
        files: z.array(
          z.object({
            mediaId: z.string().min(1).max(100).optional(),
            url: z.string().url().optional(),
            objectKey: z.string().optional(),
            key: z.string().optional(),
            mime: z.string().default(""),
            size: z.number().default(0),
            name: z.string().default(""),
            width: z.number().optional(),
            height: z.number().optional(),
            durationMs: z.number().nonnegative().optional(),
            // Sender-uploaded poster frame for videos/animated GIFs — zod strips
            // unknown keys, so leaving it out dropped it before persistence.
            thumbnailObjectKey: z.string().max(500).optional(),
            mediaBatchId: z.string().max(64).optional(),
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

/**
 * REST body for `POST /community/rooms/:roomId/read`. `communityId` is
 * required so the read-receipt broadcast reaches the right /community room
 * (clients join community:<communityId>, mirroring send/edit); `upToMessageId`
 * gives a per-message high-water mark, matching private/group's live read
 * receipt instead of community's previous read-to-now-only behavior.
 */
export const markCommunityReadBodySchema = z.object({
  communityId: z.string().min(1),
  upToMessageId: z.string().min(1).max(150),
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
  // "set" => caller ends up with exactly `emoji` (re-sending the same one clears it), so changing a
  // reaction is ONE call. Omitted/"toggle" keeps the legacy per-emoji flip for existing clients.
  mode: z.preprocess(
    (v) => (typeof v === "string" ? v.toLowerCase() : v),
    z.enum(["toggle", "set"]).default("toggle")
  ),
});

export const reportMessageSchema = z.object({
  roomId: z.string().min(10).max(300),
  messageId: z.string().min(10).max(300),
  reportReason: z.string().min(1).max(200).trim(),
  reportDescription: z.string().max(300).trim().default(""),
});

/**
 * `GET /chat/community/rooms/search`. `page`/`limit` are declared here on
 * purpose: `validateQuery` replaces `req.query` with the parsed object, so a key
 * missing from the schema is STRIPPED and the handler silently falls back to its
 * default (the bug that made community `before_seq` a no-op). `limit` is bounded
 * so the search can't be asked for an unbounded page.
 */
export const searchRoomsSchema = z.object({
  query: z.string().min(1).max(100),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** `GET /chat/community/rooms` — same bounded pagination, no search term. */
export const listRoomsSchema = searchRoomsSchema.omit({ query: true });

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

/**
 * REST body for `POST /community/rooms/:roomId/messages/:messageId/forward`.
 * roomId (path) is the SOURCE room — bound in the service to the message's
 * actual room, closing the cross-community forward read-IDOR (mirrors
 * private/group's forward route). targetCommunityId/targetRoomId identify the
 * destination community + its chat room.
 */
export const forwardCommunityMessageBodySchema = z.object({
  targetCommunityId: z.string().min(1),
  targetRoomId: z.string().min(1),
  clientMessageId: z.string().min(1).max(100).nullish(),
});
