import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  categoryIdParamSchema,
  createCategorySchema,
  listCategoriesQuerySchema,
  updateCategorySchema,
} from "../validators/index.js";

/** Category Management admin API — self-prefixed `/categories`. */
export const categoryRoutes: IRouter = Router();

categoryRoutes.use(adminAuth);

categoryRoutes.get(
  "/categories",
  requirePermission(PERMISSIONS.CATEGORIES_MANAGE),
  validateQuery(listCategoriesQuerySchema),
  listCategories
);
categoryRoutes.post(
  "/categories",
  requirePermission(PERMISSIONS.CATEGORIES_MANAGE),
  validateBody(createCategorySchema),
  createCategory
);
categoryRoutes.patch(
  "/categories/:categoryId",
  requirePermission(PERMISSIONS.CATEGORIES_MANAGE),
  validateParams(categoryIdParamSchema),
  validateBody(updateCategorySchema),
  updateCategory
);
categoryRoutes.delete(
  "/categories/:categoryId",
  requirePermission(PERMISSIONS.CATEGORIES_MANAGE),
  validateParams(categoryIdParamSchema),
  deleteCategory
);
