import { z } from "zod";

export const refreshTokenSchema = z.object({
  refreshToken: z.string().trim().min(1, "refreshToken is required"),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

export const sessionIdParamsSchema = z.object({
  sessionId: z.string().uuid("Invalid session id"),
});

export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;
