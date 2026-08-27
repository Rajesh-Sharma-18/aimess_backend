import { ConflictError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { clearUserBanned } from "@aimess/redis";

import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import { AccountStatus } from "../generated/prisma/client.js";
import { publishUserRestored } from "../messaging/publish-user-restored.js";
import { authRepository } from "../repositories/auth.repository.js";
import { authAuditService } from "./audit.service.js";

export type RestoreAccountInput = {
  userId: string;
  /** backoffice AdminUser.id. NOT an AuthUser.id — recorded on the audit row only. */
  actorAdminId?: string | null;
};

export type RestoreAccountResult = {
  status: AccountStatus;
  restoredAt: Date;
};

/**
 * Super Admin reactivation of a soft-deleted account — the exact inverse of
 * accountDeletionService.deleteAccount, and the only writer of the
 * PENDING_DELETION → ACTIVE transition.
 *
 * Why this is a complete restore rather than a partial one: the delete flow
 * never removed a row or overwrote a stored value anywhere on the platform.
 * auth-service marked the AuthUser (deletedAt + PENDING_DELETION +
 * scheduledDeletionAt) and revoked sessions in place; user-service marked the
 * UserProfile (deletedAt + status DELETED) WITHOUT touching username, names,
 * bio, avatar or any other column. The "Deleted Account" name and blank avatar
 * every other service shows are a READ-TIME projection of those two flags
 * (user-service's BulkGetUserSnapshots, chat-service's deleted-identity.ts) or
 * a denormalized copy of that projection (community-service member snapshots),
 * never a destructive write. Chat rooms, messages, attachments, group and
 * community memberships, friendships, notifications and media were untouched by
 * deletion — no service other than user-service even consumes `user.deleted`.
 *
 * So restoring is: clear the two flags, then let the ordinary
 * `user.profile_updated` fanout push the real identity back over every
 * denormalized placeholder. That is what the `user.restored` event below
 * triggers in user-service.
 */
export const accountRestoreService = {
  async restore(input: RestoreAccountInput): Promise<RestoreAccountResult> {
    const user = await prisma.authUser.findUnique({
      where: { id: input.userId },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!user) {
      throw new NotFoundError("USER_NOT_FOUND");
    }

    const isDeleted =
      user.deletedAt !== null || user.status === AccountStatus.PENDING_DELETION;

    // Only a deleted account can be reactivated — with one deliberate
    // exception below. A BANNED or SUSPENDED account is a different state with
    // a different remedy (unban), and silently clearing a ban here would let
    // "Re-Activate" launder a moderation decision.
    if (!isDeleted && user.status !== AccountStatus.ACTIVE) {
      throw new ConflictError("USER_NOT_DELETED");
    }

    // The exception: an ALREADY-ACTIVE account is a RE-DRIVE, not a conflict,
    // and this is the single most important property of the whole flow.
    //
    // The auth write below commits before the `user.restored` publish, so any
    // failure in between (broker down, dead channel) leaves an account that can
    // log in while user-service still has the profile deleted. If this guard
    // rejected an already-ACTIVE account, that half-restored state would be
    // PERMANENT: the retry the admin is told to perform would 409 here, and
    // nothing else in the monorepo publishes `user.restored`.
    //
    // So restoring an account that is already ACTIVE skips the DB write and the
    // ban-flag clear (both would be no-ops on a healthy account, and skipping
    // the latter is what stops this becoming a backdoor unban) and re-publishes
    // the event. The user-service handler is itself idempotent — it exits early
    // on an already-active profile — so re-driving a COMPLETED restore changes
    // nothing, while re-driving a HALF-FINISHED one finishes it.
    const restoredAt = isDeleted
      ? (await authRepository.restoreUser(input.userId)).restoredAt
      : new Date();

    if (isDeleted) {
      // The account may have been banned before it was deleted, in which case
      // the Redis ban flag is still set and community-service / stream-service
      // (which consult the flag, not the session) would keep rejecting the
      // restored user. Restoring to ACTIVE has to clear it, exactly as
      // accountBanService.lift does.
      await clearUserBanned(redis, input.userId);
    }

    // Written BEFORE the publish, not after: `restoreUser` has already
    // committed by this point, so the trail must record that mutation even if
    // the publish then fails. `record` swallows its own errors, so it cannot
    // itself become a new failure point.
    await authAuditService.record({
      event: "ACCOUNT_RESTORED",
      targetType: "auth_user",
      targetId: input.userId,
      userId: input.userId,
      metadata: {
        actorAdminId: input.actorAdminId ?? null,
        previousStatus: user.status,
        previousDeletedAt: user.deletedAt?.toISOString() ?? null,
        // Distinguishes the real restore from a re-drive that only republished
        // the event, so the trail is not read as two separate reactivations.
        redrive: !isDeleted,
      },
    });

    // AWAITED, unlike every other publish in this service. If the broker is
    // down this throws and the admin's request fails — but the account is left
    // in the re-drivable ACTIVE state handled above, so the retry completes the
    // restore. The alternative (swallowing it) is a login-works-but-profile-
    // still-deleted account with no signal that anything went wrong.
    await publishUserRestored({
      userId: input.userId,
      restoredAt: restoredAt.toISOString(),
      actorAdminId: input.actorAdminId ?? null,
    });

    logger.info(
      `Account ${isDeleted ? "restored" : "restore re-driven"}: user=${input.userId} by=${input.actorAdminId ?? "(unknown)"}`
    );

    return { status: AccountStatus.ACTIVE, restoredAt };
  },
};
