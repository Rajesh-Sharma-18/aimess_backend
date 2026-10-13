import { z } from "zod";

import { reportUserReasonSchema } from "../../lib/report-user.js";

// `userIds` is the batch form (one operation ⇒ one grouped MEMBER_ADDED line);
// `userId` stays for the single-member callers already on the wire. The cap
// matches the group member limit — capacity itself is still enforced per add.
export const addMemberSchema = z
  .object({
    roomId: z.string().min(5).max(100),
    userId: z.string().min(5).max(100).optional(),
    userIds: z.array(z.string().min(5).max(100)).min(1).max(256).optional(),
    shareHistory: z.boolean().optional().default(false),
  })
  .refine((body) => Boolean(body.userId) || Boolean(body.userIds?.length), {
    message: "userId or userIds is required",
    path: ["userId"],
  });

export const leaveGroupSchema = z.object({
  reason: z.string().max(100).optional(),
  successorId: z.string().min(5).max(100).optional(),
});

export const kickMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
  reason: z.string().max(1000).optional(),
});

export const updateRoleSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
  // Leader handover is the only role change groups have.
  role: z.literal("ADMIN"),
});

export const markReadSchema = z.object({
  roomId: z.string().min(5).max(100),
  lastMessageId: z.string().min(5).max(100),
});

export const muteGroupSchema = z.object({
  muteUntil: z.string().datetime().nullish(),
});

// Reason rule shared with the private-chat user report — see lib/report-user.ts.
export const reportMemberSchema = z.object({
  roomId: z.string().min(5).max(100),
  userId: z.string().min(5).max(100),
  reason: reportUserReasonSchema,
  description: z.string().max(1000).default(""),
});
