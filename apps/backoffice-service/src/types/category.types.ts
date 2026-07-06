import type { PaginationMeta, Paginated } from "./moderation.types.js";

export type { PaginationMeta, Paginated };

/** A single row returned by GET /categories. */
export type CategoryListItem = {
  id: string;
  name: string;
  slug: string;
  visible: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
};

/** Same shape as the list item — create/update return the full row. */
export type CategoryDetail = CategoryListItem;

/** Normalized create input (post-validation). */
export type CreateCategoryInput = {
  name: string;
};

/** Normalized update input (post-validation) — at least one field present. */
export type UpdateCategoryInput = {
  name?: string;
  visible?: boolean;
};

/** Normalized list query (post-validation/coercion). */
export type ListCategoriesQuery = {
  search?: string;
  status?: "visible" | "hidden" | "all";
  sort: string;
  page: number;
  limit: number;
};

export type DeleteCategoryResult = {
  softDeleted: boolean;
};
