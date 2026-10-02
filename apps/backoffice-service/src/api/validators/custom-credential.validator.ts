import { z } from "zod";

import { CUSTOM_CREDENTIAL_PLATFORMS } from "../../types/custom-credential.types.js";

const nameSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, "Name must be uppercase letters, digits and underscores");

const valueSchema = z
  .string()
  .trim()
  .min(8)
  .max(512)
  .regex(/^\S+$/, "Credential must not contain whitespace");

const platformSchema = z.enum(CUSTOM_CREDENTIAL_PLATFORMS);

export const customCredentialIdParamSchema = z.object({
  credentialId: z.string().uuid(),
});
export type CustomCredentialIdParam = z.infer<typeof customCredentialIdParamSchema>;

export const createCustomCredentialSchema = z
  .object({
    name: nameSchema,
    platform: platformSchema,
    value: valueSchema,
  })
  .strict();
export type CreateCustomCredentialBody = z.infer<typeof createCustomCredentialSchema>;

export const updateCustomCredentialSchema = z
  .object({
    name: nameSchema.optional(),
    platform: platformSchema.optional(),
    value: valueSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.platform !== undefined || v.value !== undefined,
    { message: "At least one of name, platform or value must be provided" }
  );
export type UpdateCustomCredentialBody = z.infer<typeof updateCustomCredentialSchema>;
