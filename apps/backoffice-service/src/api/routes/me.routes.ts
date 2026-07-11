import { Router, type IRouter } from "express";

import { changePassword, getMe, updateMe } from "../controllers/index.js";
import { adminAuth, validateBody } from "../middleware/index.js";
import { changePasswordSchema, updateMeSchema } from "../validators/index.js";

/**
 * Self-service "My Account" routes. Self-prefixed so they resolve at
 * `/v1/me` and `/v1/change-password` when mounted at the root — matching
 * the gateway paths `/admin/v1/me` and `/admin/v1/change-password`.
 */
export const meRoutes: IRouter = Router();

meRoutes.use(adminAuth);

meRoutes.get("/me", getMe);
meRoutes.patch("/me", validateBody(updateMeSchema), updateMe);
meRoutes.patch(
  "/change-password",
  validateBody(changePasswordSchema),
  changePassword
);
