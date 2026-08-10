import { z } from "zod";

import { reportUserReasonSchema } from "../../lib/report-user.js";

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
  role: z.enum(["ADMIN", "MODERATOR", "MEMBER"]),
});

export const markReadSchema = z.object({
  roomId: z.string().min(5).max(100),
  lastMessageId: z.string().min(5).max(100),
});

export const muteGroupSchema = z.object({
  muteUntil: z.string().datetime().nullish(),
});

// Moderator-imposed mute on ANOTHER member — distinct from muteGroupSchema
// (self-notification mute for the caller's own membership). `durationMinutes`
// mirrors community's `setMemberMuteSchema`: the SERVER computes the expiry
// from its own clock (null/omitted = indefinite), so a client's local clock
// can never produce an expiry that's already in the past. `mutedUntil` stays
// accepted for back-compat with any existing caller sending an absolute
// timestamp, but `durationMinutes` wins when both are present.
export const muteMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
  durationMinutes: z
    .number()
    .int()
    .min(1, "Mute duration must be at least 1 minute")
    .max(525_600, "Mute duration must be at most 365 days")
    .nullable()
    .optional(),
  mutedUntil: z.string().datetime().nullish(),
});

export const unmuteMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
});

// Reason rule shared with the private-chat user report — see lib/report-user.ts.
export const reportMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
  reason: reportUserReasonSchema,
  description: z.string().max(1000).default(""),
});
