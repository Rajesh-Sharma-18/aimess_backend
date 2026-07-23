import { z } from "zod";

// Phase 1 group size: 1–256 members. Was 2..5000; the hard 256 ceiling is a
// product decision (parity with WhatsApp/Signal-scale groups), keeps member
// list, roster fan-out, and read-receipt joins on a bounded working set.
const GROUP_MEMBER_MIN = 1;
const GROUP_MEMBER_MAX = 256;

export const createGroupSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  description: z.string().max(1000).default(""),
  avatar: z.string().default(""),
  memberLimit: z
    .number()
    .int()
    .min(GROUP_MEMBER_MIN)
    .max(GROUP_MEMBER_MAX)
    .default(GROUP_MEMBER_MAX),
});

export const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(1000).optional(),
  avatar: z.string().optional(),
  memberLimit: z
    .number()
    .int()
    .min(GROUP_MEMBER_MIN)
    .max(GROUP_MEMBER_MAX)
    .optional(),
});
