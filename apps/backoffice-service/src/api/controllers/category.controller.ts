import { HTTP_STATUS } from "@aimess/constants";
import type { RequestHandler } from "express";

import { categoryService } from "../../services/index.js";
import type { ListCategoriesQuery } from "../../types/category.types.js";
import type {
  CreateCategoryInput,
  ListCategoriesQueryInput,
  UpdateCategoryInput,
} from "../validators/index.js";

/** GET /v1/categories — paginated, searchable, sortable list. */
export const listCategories: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListCategoriesQueryInput;
      const result = await categoryService.listCategories(
        query as ListCategoriesQuery
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
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
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: result });
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
      res.status(HTTP_STATUS.OK).json({ success: true, data: result });
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
      res.status(HTTP_STATUS.OK).json({ success: true, data: null });
    } catch (error) {
      next(error);
    }
  })();
};
