import { z } from "zod";

export const updateUserAccountSchema = z
  .object({
    firstName: z.string().max(200).optional(),
    lastName: z.string().max(200).optional(),
    username: z.string().max(64).optional(),
    bio: z.string().max(1000).nullable().optional(),
    dateOfBirth: z.string().max(10).optional(),
    gender: z.string().max(32).nullable().optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "ADMIN_USER_NO_CHANGES",
  });
export type UpdateUserAccountInput = z.infer<typeof updateUserAccountSchema>;

export const userSocialProviderParamSchema = z.object({
  userId: z.string().trim().min(1).max(64),
  provider: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(["GOOGLE", "APPLE"])),
});
export type UserSocialProviderParam = z.infer<
  typeof userSocialProviderParamSchema
>;
