import { z } from "zod";

/**
 * Shared attachment shapes used across private, group, and community messages.
 * These live inside the message's Json blob (content for private/group,
 * attachments for community) — no Prisma schema change required.
 */

export const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  placeName: z.string().max(200).optional(),
  placeAddress: z.string().max(500).optional(),
});

export const contactSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(50),
  avatar: z.string().max(3000).optional(),
  userId: z.string().max(100).optional(),
});

export const stickerSchema = z
  .object({
    objectKey: z.string().min(1).max(500).optional(),
    url: z.string().url().optional(),
    packId: z.string().max(100),
    stickerId: z.string().max(100),
  })
  .refine((d) => d.objectKey || d.url, "sticker needs objectKey or url");

export type LocationAttachment = z.infer<typeof locationSchema>;
export type ContactAttachment = z.infer<typeof contactSchema>;
export type StickerAttachment = z.infer<typeof stickerSchema>;
