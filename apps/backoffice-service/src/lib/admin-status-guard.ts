import { ForbiddenError } from "@aimess/errors";

import type { AdminStatus } from "../generated/prisma/client.js";

/**
 * Rejects a non-ACTIVE admin with the right distinct reason: DELETED (row kept
 * for audit trail, account permanently gone) vs DISABLED/INVITED (temporarily
 * deactivated, may be reactivated). Shared by the auth gate and any service
 * that re-checks admin status mid-flow (e.g. change-password).
 */
export function assertAdminAccountAccessible(admin: {
  status: AdminStatus;
}): void {
  if (admin.status === "DELETED") {
    throw new ForbiddenError("ADMIN_ACCOUNT_DELETED");
  }
  if (admin.status !== "ACTIVE") {
    throw new ForbiddenError("ADMIN_ACCOUNT_NOT_ACTIVE");
  }
}
