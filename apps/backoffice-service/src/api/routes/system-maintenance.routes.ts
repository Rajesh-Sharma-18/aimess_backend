import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import { disconnectAllFriendships } from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
} from "../middleware/index.js";
import { disconnectAllFriendshipsSchema } from "../validators/index.js";

/**
 * System Maintenance admin API — self-prefixed `/system` so it resolves at
 * `/v1/system/*`, matching the gateway path convention (the gateway strips
 * `/admin` and forwards `/v1/*` verbatim). Every route needs a valid admin
 * bearer + `settings.manage` — SUPER_ADMIN only (see role-matrix.ts) — because
 * every action here is platform-wide, not scoped to one user/community/group.
 */
export const systemMaintenanceRoutes: IRouter = Router();

systemMaintenanceRoutes.use(adminAuth);

systemMaintenanceRoutes.post(
  "/system/friendships/disconnect-all",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateBody(disconnectAllFriendshipsSchema),
  disconnectAllFriendships
);
