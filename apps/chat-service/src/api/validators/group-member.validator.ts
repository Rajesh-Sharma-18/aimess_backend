import { z } from "zod";

export const addMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
});

export const kickMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
  reason: z.string().max(1000).optional(),
});

export const banMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
  reason: z.string().max(1000).optional(),
});

export const unbanMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
});

export const updateRoleSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
  role: z.enum(["OWNER", "ADMIN", "MODERATOR", "MEMBER"]),
});

export const markReadSchema = z.object({
  roomId: z.string().min(5).max(100),
  lastMessageId: z.string().min(5).max(100),
});

export const muteGroupSchema = z.object({
  muteUntil: z.string().datetime().nullish(),
});

// Same reason vocabulary as private message reports — both flow into the same
// backoffice ingest queue, so keeping the enum aligned avoids downstream
// normalization.
export const reportMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
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
