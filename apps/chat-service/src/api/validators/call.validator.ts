import { z } from "zod";

export const callHistoryQuerySchema = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
