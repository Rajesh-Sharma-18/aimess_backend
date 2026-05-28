import { z } from "zod";

export const createGroupSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  description: z.string().max(1000).default(""),
  avatar: z.string().default(""),
  memberLimit: z.number().int().min(2).max(5000).default(50),
});

export const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(1000).optional(),
  avatar: z.string().optional(),
  memberLimit: z.number().int().min(2).max(5000).optional(),
});
