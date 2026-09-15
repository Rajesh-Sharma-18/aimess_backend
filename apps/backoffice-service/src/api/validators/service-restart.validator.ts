import { z } from "zod";

import { RESTARTABLE_KEYS } from "../../lib/service-restart.js";

/**
 * Path params for POST /v1/system-health/services/:serviceKey/restart. Only an
 * allowlisted System Health key parses — never a container name or a command.
 */
export const serviceRestartParamsSchema = z
  .object({ serviceKey: z.enum(RESTARTABLE_KEYS) })
  .strict();

export type ServiceRestartParams = z.infer<typeof serviceRestartParamsSchema>;
