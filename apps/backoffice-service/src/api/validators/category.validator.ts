import { z } from "zod";

/**
 * Zod schemas + inferred types for the Category Management admin API.
 * Mirrors the pattern in announcement.validator.ts (whitelisted sort, offset
 * pagination). Name length/trim rules mirror community-service's
 * categoryNameSchema (2..80 chars) since community-service is the source of
 * truth for the underlying data.
 */

export const categoryStatusEnum = z.enum(["visible", "hidden", "all"]);

const SORT_FIELDS = ["name", "order", "createdAt"] as const;
const SORT_PATTERN = new RegExp(`^(${SORT_FIELDS.join("|")}):(asc|desc)$`);

const categoryNameSchema = z
  .string()
  .trim()
  .min(2, "Category name must be at least 2 characters")
  .max(80, "Category name must be at most 80 characters");

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------
export const createCategorySchema = z.object({
  name: categoryNameSchema,
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

// ---------------------------------------------------------------------------
// Update.
// ---------------------------------------------------------------------------
export const updateCategorySchema = z
  .object({
    name: categoryNameSchema.optional(),
    visible: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.visible !== undefined, {
    message: "At least one of name or visible must be provided",
  });
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listCategoriesQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  status: categoryStatusEnum.default("all"),
  sort: z
    .string()
    .regex(SORT_PATTERN, "Sort must be in the format field:asc or field:desc")
    .default("order:asc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListCategoriesQueryInput = z.infer<
  typeof listCategoriesQuerySchema
>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const categoryIdParamSchema = z.object({
  categoryId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{24}$/i, "Category id is invalid"),
});
export type CategoryIdParam = z.infer<typeof categoryIdParamSchema>;
