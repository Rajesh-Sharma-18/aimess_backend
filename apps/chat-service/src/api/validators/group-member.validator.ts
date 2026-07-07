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
