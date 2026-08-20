import { HTTP_STATUS, t } from "@aimess/constants";
import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";

import { categoryService } from "../../services/index.js";
import { paginated } from "../lib/respond.js";
import type { ListCategoriesQuery } from "../../types/category.types.js";
import type {
  CreateCategoryInput,
  ListCategoriesQueryInput,
  UpdateCategoryInput,
  UpdateCategoryVisibilityInput,
} from "../validators/index.js";

/** GET /v1/categories — paginated, searchable, sortable list. */
export const listCategories: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListCategoriesQueryInput;
      const result = await categoryService.listCategories(
        query as ListCategoriesQuery
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_CATEGORIES_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/categories */
export const createCategory: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const body = req.body as CreateCategoryInput;
      const result = await categoryService.createCategory(body, req.admin!.id);
      res
        .status(HTTP_STATUS.CREATED)
        .json(new ApiResponse(result, t("ADMIN_CATEGORY_CREATED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** PATCH /v1/categories/:categoryId */
export const updateCategory: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const categoryId = req.params.categoryId as string;
      const body = req.body as UpdateCategoryInput;
      const result = await categoryService.updateCategory(
        categoryId,
        body,
        req.admin!.id
      );
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_CATEGORY_UPDATED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** PATCH /v1/categories/:categoryId/visibility */
export const updateCategoryVisibility: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const categoryId = req.params.categoryId as string;
      const body = req.body as UpdateCategoryVisibilityInput;
      const result = await categoryService.updateCategoryVisibility(
        categoryId,
        body.status,
        req.admin!.id
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            result,
            t("ADMIN_CATEGORY_VISIBILITY_UPDATED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** DELETE /v1/categories/:categoryId */
export const deleteCategory: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const categoryId = req.params.categoryId as string;
      await categoryService.deleteCategory(categoryId, req.admin!.id);
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(null, t("ADMIN_CATEGORY_DELETED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};
