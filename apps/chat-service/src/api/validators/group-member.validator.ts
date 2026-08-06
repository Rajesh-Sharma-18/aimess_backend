import { z } from "zod";

export const addMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
});

export const leaveGroupSchema = z.object({
  reason: z.string().max(100).optional(),
});

export const kickMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
  reason: z.string().max(1000).optional(),
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

// Moderator-imposed mute on ANOTHER member — distinct from muteGroupSchema
// (self-notification mute for the caller's own membership).
export const muteMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
  mutedUntil: z.string().datetime().nullish(),
});

export const unmuteMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
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
