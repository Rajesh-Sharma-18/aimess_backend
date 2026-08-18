import { CALL_HISTORY_FILTERS } from "@aimess/constants";
import { z } from "zod";

export const callHistoryQuerySchema = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Grouped history — same cursor/limit contract, plus the tab filter. */
export const callHistoryGroupedQuerySchema = callHistoryQuerySchema.extend({
  filter: z.enum(CALL_HISTORY_FILTERS).default("all"),
});
