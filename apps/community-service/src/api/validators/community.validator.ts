import { z } from "zod";

import { normalizeHandle } from "../../lib/community-slug.util.js";

const OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i;

const nameSchema = z
  .string()
  .trim()
  .min(3, "Name must be at least 3 characters")
  .max(50, "Name must be at most 50 characters");

const handleSchema = z
  .string()
  .trim()
  .transform((s) => normalizeHandle(s))
  .pipe(
    z
      .string()
      .min(3, "Handle must be at least 3 characters")
      .max(32, "Handle must be at most 32 characters")
      .regex(
        /^[a-z0-9_]+$/,
        "Handle may only contain lowercase letters, numbers, and underscores"
      )
  );

const descriptionSchema = z
  .string()
  .trim()
  .max(500, "Description must be at most 500 characters");

const categoryIdSchema = z
  .string()
  .trim()
  .regex(OBJECT_ID_REGEX, "categoryId must be a 24-character hex ObjectId");

const objectKeySchema = z.string().trim().min(1).max(512);

const memberIdsSchema = z
  .array(z.string().uuid("memberIds must be UUIDs"))
  .max(500, "Too many members")
  .transform((ids) => [...new Set(ids)]);

export const createCommunitySchema = z.object({
  name: nameSchema,
  handle: handleSchema,
  type: z.enum(["PUBLIC", "PRIVATE"]),
  categoryId: categoryIdSchema,
  description: descriptionSchema.optional(),
  avatarObjectKey: objectKeySchema.optional(),
  memberIds: memberIdsSchema.default([]),
});

export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;

export const updateCommunitySchema = z
  .object({
    name: nameSchema.optional(),
    handle: handleSchema.optional(),
    type: z.enum(["PUBLIC", "PRIVATE"]).optional(),
    categoryId: categoryIdSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    avatarObjectKey: objectKeySchema.nullable().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.handle !== undefined ||
      body.type !== undefined ||
      body.categoryId !== undefined ||
      body.description !== undefined ||
      body.avatarObjectKey !== undefined,
    { message: "At least one field is required to update" }
  );

export type UpdateCommunityInput = z.infer<typeof updateCommunitySchema>;

export const communityIdParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(OBJECT_ID_REGEX, "id must be a 24-character hex ObjectId"),
});

export type CommunityIdParams = z.infer<typeof communityIdParamsSchema>;

export const nameAvailableQuerySchema = z.object({
  name: nameSchema,
});

export type NameAvailableQuery = z.infer<typeof nameAvailableQuerySchema>;

export const handleAvailableQuerySchema = z.object({
  handle: handleSchema,
});

export type HandleAvailableQuery = z.infer<typeof handleAvailableQuerySchema>;

export const myCommunitiesQuerySchema = z.object({
  cursor: z.string().trim().regex(OBJECT_ID_REGEX).optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

export type MyCommunitiesQuery = z.infer<typeof myCommunitiesQuerySchema>;
