import { z } from "zod";

export const accountSchema = z
  .string()
  .trim()
  .min(3, "Account must be at least 3 characters")
  .max(32, "Account must be at most 32 characters")
  .regex(
    /^[a-zA-Z0-9_]+$/,
    "Account may only contain letters, numbers, and underscores"
  );

export const validateAccountSchema = z.object({
  account: accountSchema,
});

export type ValidateAccountInput = z.infer<typeof validateAccountSchema>;

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters");

export const registerSchema = z.object({
  account: accountSchema,
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;

/** Login handle: username (`account`) or verified linked email. */
export const loginIdentifierSchema = z
  .string()
  .trim()
  .min(3, "Account or email is required")
  .max(254, "Account or email is too long")
  .refine(
    (value) => {
      const asEmail = z.string().email().safeParse(value.toLowerCase());
      const asAccount = accountSchema.safeParse(value);
      return asEmail.success || asAccount.success;
    },
    { message: "Enter a valid account name or email address" }
  );

export const loginSchema = z.object({
  account: loginIdentifierSchema,
  password: passwordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;
