import { ConflictError, ServiceUnavailableError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { isAdminEmailTaken } from "../grpc/backoffice.client.js";
import { authRepository } from "../repositories/auth.repository.js";

/**
 * Single gate for every path that writes an email onto an AuthUser (link,
 * change, social sign-up). An address may belong to exactly ONE identity across the platform:
 * another end user, or an admin/sub-admin in backoffice-service's admin_db.
 *
 * Admin emails live in a different database with no shared unique index, so the
 * cross-service check is the only thing standing between the two — a failure to
 * reach backoffice-service rejects the request (503) instead of allowing a
 * duplicate that nothing downstream can undo.
 *
 * The admin case reuses AUTH_EMAIL_EXISTS on purpose: a caller must not be able
 * to enumerate which addresses belong to admin accounts.
 */
export async function assertEmailAvailable(
  email: string,
  excludeUserId?: string
): Promise<void> {
  // No excludeUserId = the account does not exist yet (social sign-up), so
  // every AuthUser row counts, including soft-deleted ones holding the index.
  const taken = excludeUserId
    ? await authRepository.findEmailTakenByOtherUser(email, excludeUserId)
    : await authRepository.findByEmail(email);
  if (taken) {
    throw new ConflictError("AUTH_EMAIL_EXISTS");
  }

  let adminTaken: boolean;
  try {
    adminTaken = await isAdminEmailTaken(email);
  } catch (error) {
    logger.error("Admin email availability check failed", { error });
    throw new ServiceUnavailableError("SERVICE_UNAVAILABLE");
  }

  if (adminTaken) {
    throw new ConflictError("AUTH_EMAIL_EXISTS");
  }
}
