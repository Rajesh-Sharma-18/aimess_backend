import { z } from "zod";

export const createInviteLinkSchema = z.object({
  roomId: z.string().min(5).max(100),
  expiresAt: z.string().datetime().nullish(),
  maxUses: z.number().int().positive().nullish(),
  shareName: z.string().max(200).default(""),
});

export const revokeInviteLinkSchema = z.object({
  token: z.string().min(10).max(100),
});

export const joinByInviteLinkSchema = z.object({
  token: z.string().min(10).max(100),
});

export const previewInviteLinkSchema = z.object({
  token: z.string().min(10).max(100),
});

export const bulkSendInviteLinkSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(50),
  token: z.string().min(10).max(100).nullish(),
  inviteUrl: z.string().max(500).nullish(),
});
