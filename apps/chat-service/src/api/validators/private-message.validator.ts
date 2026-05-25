import { z } from "zod";

import { locationSchema, contactSchema } from "./attachment.validator.js";

export const sendPrivateMessageSchema = z.object({
  roomId: z.string().min(5).max(300),
  receiverId: z.string().min(5).max(100),
  content: z.object({
    text: z.string().default(""),
    urls: z.array(z.string().url()).default([]),
    files: z
      .array(
        z.object({
          url: z.string().url(),
          name: z.string(),
          size: z.number(),
          mime: z.string(),
        })
      )
      .default([]),
    location: locationSchema.optional(),
    contact: contactSchema.optional(),
  }),
  messageType: z.enum([
    "TEXT",
    "IMAGE",
    "DOCUMENT",
    "VIDEO",
    "SYSTEM",
    "LOCATION",
    "CONTACT",
  ]),
  parentMessageId: z.string().nullish(),
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
