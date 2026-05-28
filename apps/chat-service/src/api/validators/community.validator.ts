import { z } from "zod";

import { locationSchema, contactSchema } from "./attachment.validator.js";

export const sendCommunityMessageSchema = z.object({
  roomId: z.string().min(5).max(50),
  message: z.string().default(""),
  messageType: z.enum([
    "image",
    "text",
    "voice",
    "custom",
    "location",
    "contact",
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
        })
      ),
    })
    .optional(),
  location: locationSchema.optional(),
  contact: contactSchema.optional(),
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

export const reportMessageSchema = z.object({
  roomId: z.string().min(10).max(300),
  messageId: z.string().min(10).max(300),
  reportReason: z.string().min(1).max(200).trim(),
  reportDescription: z.string().max(300).trim().default(""),
});

export const searchRoomsSchema = z.object({
  query: z.string().min(1).max(100),
});
