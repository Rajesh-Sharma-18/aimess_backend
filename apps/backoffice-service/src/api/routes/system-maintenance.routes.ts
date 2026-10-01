import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  disconnectAllFriendships,
  getCallingEnabled,
  setCallingEnabled,
  getAppUpdatePolicy,
  setAppUpdatePolicy,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
} from "../middleware/index.js";
import {
  disconnectAllFriendshipsSchema,
  setCallingEnabledSchema,
  appUpdatePolicySchema,
} from "../validators/index.js";

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

// Platform-wide calling kill-switch. READ is available to anyone who can see
// system health (the state is diagnostic); WRITE stays SUPER_ADMIN-only like
// every other platform-wide action on this router.
systemMaintenanceRoutes.get(
  "/system/calling",
  requirePermission(PERMISSIONS.SYSTEMHEALTH_READ),
  getCallingEnabled
);
systemMaintenanceRoutes.patch(
  "/system/calling",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateBody(setCallingEnabledSchema),
  setCallingEnabled
);

// App update policy (force rules + store-decision config, per platform). READ for
// anyone who can see system health; WRITE is SUPER_ADMIN-only — a force rule can
// block every user on a platform.
systemMaintenanceRoutes.get(
  "/system/app-update-policy",
  requirePermission(PERMISSIONS.SYSTEMHEALTH_READ),
  getAppUpdatePolicy
);
systemMaintenanceRoutes.put(
  "/system/app-update-policy",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateBody(appUpdatePolicySchema),
  setAppUpdatePolicy
);
