import { ConflictError, NotFoundError } from "@aimess/errors";

import {
  communityClient,
  type RawAdminCategoryRow,
} from "../grpc/community.client.js";
import type {
  CategoryDetail,
  CategoryListItem,
  CreateCategoryInput,
  DeleteCategoryResult,
  ListCategoriesQuery,
  Paginated,
  PaginationMeta,
  UpdateCategoryInput,
} from "../types/category.types.js";

function toItem(row: RawAdminCategoryRow): CategoryListItem {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    visible: row.visible,
    order: row.order,
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
  };
}

/**
 * Maps a business `errorCode` returned by the community-service gRPC bridge
 * to the same AppError types the rest of backoffice-service throws — same
 * convention as `mapModerationError` in community.grpc.repository.ts.
 */
function mapCategoryError(errorCode: string): Error {
  if (errorCode === "CATEGORY_NOT_FOUND") {
    return new NotFoundError("CATEGORY_NOT_FOUND");
  }
  return new ConflictError(errorCode);
}

/**
 * Categories are owned by community-service (CommunityCategory) — this
 * repository is a thin gRPC pass-through, not a duplicate data store.
 */
export const categoryRepository = {
  async list(query: ListCategoriesQuery): Promise<Paginated<CategoryListItem>> {
    const [sortField, sortDir] = query.sort.split(":");
    const res = await communityClient.adminListCategories({
      search: query.search ?? "",
      status: query.status && query.status !== "all" ? query.status : "",
      page: query.page,
      limit: query.limit,
      sortField: sortField ?? "",
      sortDir: sortDir ?? "",
    });

    const { total } = res;
    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);
    const pagination: PaginationMeta = {
      mode: "offset",
      page: query.page,
      limit: query.limit,
      total,
      totalApprox: total,
      totalPages,
      hasNext: query.page * query.limit < total,
      hasPrev: query.page > 1,
      nextCursor: null,
    };

    return { data: res.categories.map(toItem), pagination };
  },

  async create(input: CreateCategoryInput): Promise<CategoryDetail> {
    const res = await communityClient.adminCreateCategory({
      name: input.name,
    });
    if (!res.ok || !res.category) throw mapCategoryError(res.errorCode);
    return toItem(res.category);
  },

  async update(
    id: string,
    input: UpdateCategoryInput
  ): Promise<CategoryDetail> {
    const res = await communityClient.adminUpdateCategory({
      categoryId: id,
      name: input.name,
      visible: input.visible,
    });
    if (!res.ok || !res.category) throw mapCategoryError(res.errorCode);
    return toItem(res.category);
  },

  async delete(id: string): Promise<DeleteCategoryResult> {
    const res = await communityClient.adminDeleteCategory(id);
    if (!res.ok) throw mapCategoryError(res.errorCode);
    return { softDeleted: res.softDeleted };
  },
};
