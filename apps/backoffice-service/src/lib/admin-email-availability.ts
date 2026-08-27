import { ConflictError, ServiceUnavailableError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { authClient } from "../grpc/auth.client.js";
import { adminUserRepository } from "../repositories/index.js";

/**
 * Single gate for every path that writes an email onto an AdminUser (create,
 * admin-edits-admin, admin-edits-self). An address may belong to exactly ONE
 * identity across the platform: another admin here, or an end user in
 * auth-service's aimess_auth.
 *
 * End-user emails live in a different database with no shared unique index, so
 * the cross-service check is the only thing standing between the two — a
 * failure to reach auth-service rejects the request (503) instead of allowing a
 * duplicate that nothing downstream can undo. Mirrors auth-service's
 * `assertEmailAvailable`.
 */
export async function assertAdminEmailAvailable(
  email: string,
  excludeAdminId?: string
): Promise<void> {
  const owner = await adminUserRepository.findByEmail(email);
  if (owner && owner.id !== excludeAdminId) {
    throw new ConflictError("ADMIN_EMAIL_TAKEN");
  }

  let userTaken: boolean;
  try {
    userTaken = await authClient.isUserEmailTaken(email);
  } catch (error) {
    logger.error("End-user email availability check failed");
    logger.error(error);
    throw new ServiceUnavailableError("SERVICE_UNAVAILABLE");
  }

  if (userTaken) {
    throw new ConflictError("ADMIN_EMAIL_TAKEN_BY_USER");
  }
}
