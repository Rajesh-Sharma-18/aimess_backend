import { Router, type IRouter } from "express";

import { getExampleById } from "../controllers/example.controller.js";
import { validateParams } from "../middleware/validate-params.js";
import { exampleIdParamsSchema } from "../validators/example.validator.js";

export const exampleRoutes: IRouter = Router();

exampleRoutes.get(
  "/:id",
  validateParams(exampleIdParamsSchema),
  getExampleById
);
