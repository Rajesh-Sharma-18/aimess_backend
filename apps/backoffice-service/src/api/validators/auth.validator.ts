import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Email is invalid"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});
export type RefreshInput = z.infer<typeof refreshSchema>;
