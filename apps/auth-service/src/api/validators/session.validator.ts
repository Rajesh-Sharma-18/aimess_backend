import { z } from "zod";

export const refreshTokenSchema = z.object({
  refreshToken: z.string().trim().min(1, "Refresh token is required"),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

export const sessionIdParamsSchema = z.object({
  sessionId: z.string().uuid("Session ID is invalid"),
});

export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;
