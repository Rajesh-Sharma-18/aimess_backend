import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  createCustomCredential,
  deleteCustomCredential,
  getCustomCredential,
  listCustomCredentials,
  updateCustomCredential,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
} from "../middleware/index.js";
import {
  createCustomCredentialSchema,
  customCredentialIdParamSchema,
  updateCustomCredentialSchema,
} from "../validators/index.js";

export const customCredentialRoutes: IRouter = Router();

customCredentialRoutes.use(adminAuth);

customCredentialRoutes.get(
  "/custom-credentials",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  listCustomCredentials
);

customCredentialRoutes.post(
  "/custom-credentials",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateBody(createCustomCredentialSchema),
  createCustomCredential
);

customCredentialRoutes.get(
  "/custom-credentials/:credentialId",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateParams(customCredentialIdParamSchema),
  getCustomCredential
);

customCredentialRoutes.patch(
  "/custom-credentials/:credentialId",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateParams(customCredentialIdParamSchema),
  validateBody(updateCustomCredentialSchema),
  updateCustomCredential
);

customCredentialRoutes.delete(
  "/custom-credentials/:credentialId",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateParams(customCredentialIdParamSchema),
  deleteCustomCredential
);
