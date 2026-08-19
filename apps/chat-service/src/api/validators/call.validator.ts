import { z } from "zod";

export const callHistoryQuerySchema = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Body of the REST call actions (answer / decline / end).
 *
 * `legId` mirrors the socket payloads: it identifies ONE connection of the user
 * so the answer race and the hang-up authorization stay per-device rather than
 * per-account. Optional, because the REST path exists precisely for clients
 * that have no live socket, and a client that omits it falls back to the same
 * user-level behaviour the socket handlers use.
 */
export const callActionBodySchema = z.object({
  legId: z.string().min(1).max(128).optional(),
});
