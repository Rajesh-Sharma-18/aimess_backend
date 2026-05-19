import { z } from "zod";

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_]+$/);

export const generateUsernameSchema = z.object({
  account: z.string().trim().min(1).max(128),
});

export const validateUsernameSchema = z.object({
  username: usernameSchema,
});

export type GenerateUsernameInput = z.infer<typeof generateUsernameSchema>;
export type ValidateUsernameInput = z.infer<typeof validateUsernameSchema>;
