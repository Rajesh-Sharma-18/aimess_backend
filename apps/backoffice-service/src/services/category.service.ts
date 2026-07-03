import { AUDIT_ACTIONS } from "../constants/index.js";
import { categoryRepository } from "../repositories/index.js";
import type {
  CategoryDetail,
  CreateCategoryInput,
  ListCategoriesQuery,
  Paginated,
  CategoryListItem,
  UpdateCategoryInput,
} from "../types/category.types.js";
import { auditService } from "./audit.service.js";

export const categoryService = {
  listCategories(
    query: ListCategoriesQuery
  ): Promise<Paginated<CategoryListItem>> {
    return categoryRepository.list(query);
  },

  async createCategory(
    input: CreateCategoryInput,
    actorId: string
  ): Promise<CategoryDetail> {
    const category = await categoryRepository.create(input);

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.CATEGORY_CREATED,
      targetType: "category",
      targetId: category.id,
      after: { name: category.name, visible: category.visible },
    });

    return category;
  },

  async updateCategory(
    id: string,
    input: UpdateCategoryInput,
    actorId: string
  ): Promise<CategoryDetail> {
    const category = await categoryRepository.update(id, input);

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.CATEGORY_UPDATED,
      targetType: "category",
      targetId: category.id,
      after: { name: category.name, visible: category.visible },
    });

    return category;
  },

  async deleteCategory(id: string, actorId: string): Promise<void> {
    const result = await categoryRepository.delete(id);

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.CATEGORY_DELETED,
      targetType: "category",
      targetId: id,
      after: { softDeleted: result.softDeleted },
    });
  },
};
