import { Router, type IRouter } from "express";

import { createUploadUrl } from "../controllers/upload.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { uploadUrlSchema } from "../validators/upload.validator.js";

export const uploadRoutes: IRouter = Router();

uploadRoutes.post(
  "/url",
  authenticateAccessToken,
  validateBody(uploadUrlSchema),
  createUploadUrl
);
