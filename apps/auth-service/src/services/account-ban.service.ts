import { logger } from "@aimess/logger";
import {
  clearUserBanned,
  markUserBanned,
  publishSessionRevokedEvent,
  publishUserBanEvent,
} from "@aimess/redis";
import { NotFoundError } from "@aimess/errors";

import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import {
  AccountStatus,
  SessionRevokeReason,
} from "../generated/prisma/client.js";
import { markSessionsRevoked } from "../lib/session-active-cache.js";
import { publishAllSessionsRevokedSafe } from "../messaging/publish-session-revoked.js";
import { sessionRepository } from "../repositories/session.repository.js";
import { authAuditService } from "./audit.service.js";

// Permanent Super Admin ban / reinstatement — the single owner of the
// AuthUser.status write.
//
// This is the piece that was missing: until now a "ban" only ever reached
// backoffice's own UserIndex mirror in admin_db, so every status guard in this
// service (login, Google/Apple, refresh, forgot-password, password reset,
// email link, account ops) was comparing against a column that stayed ACTIVE
// forever and a banned user could sign straight back in. Those guards are all
// already correct — they just needed the status to actually be written.
//
// Called from two places, deliberately idempotent so either can run twice:
//   1. the AdminSetAccountStatus gRPC handler — the PRIMARY, synchronous path,
//      awaited by backoffice before it answers the admin's HTTP request; and
//   2. the admin.user.queue RabbitMQ consumer — a safety net that re-applies
//      the ban if the gRPC call was lost.

export type ApplyBanInput = {
  userId: string;
  reason?: string | null;
  // backoffice AdminUser.id. NOT an AuthUser.id, so it is never written to a
  // @db.Uuid FK column and never used as an actor id other services resolve.
  actorAdminId?: string | null;
};

export type BanResult = {
  status: AccountStatus;
  revokedSessions: number;
};

// Revoke every live session, bust the Redis session cache, disconnect the
// sockets, and drop the push tokens. Lifted verbatim from the admin.user.queue
// consumer's forceLogout so both paths behave identically.
async function revokeEverySession(
  userId: string,
  reason: "banned" | "terminated"
): Promise<number> {
  const active = await sessionRepository.listActiveSessionIds(userId);
  await sessionRepository.revokeAllForUser(
    userId,
    SessionRevokeReason.ADMIN_REVOKED
  );
  await markSessionsRevoked(active.map((row) => row.id));

  // Revoking in the DB + Redis only stops the NEXT request: an already-open
  // socket authenticated at handshake time and is never re-checked, so without
  // this the banned user keeps full realtime access until their access token
  // happens to expire. The gateway PSUBSCRIBEs `session-revoke:*`.
  for (const row of active) {
    void publishSessionRevokedEvent(redis, userId, row.id, reason).catch(
      () => undefined
    );
  }

  // A permanently banned user can never sign back in, so any push token left
  // behind would keep delivering notifications to a dead account.
  publishAllSessionsRevokedSafe({ userId });

  return active.length;
}

export const accountBanService = {
  // Permanently ban an account. No duration: the status stays BANNED until
  // `lift` is called.
  //
  // Ordering matters. The Redis ban flag is written BEFORE the status row so
  // there is no window in which the account is still ACTIVE to the shared
  // request guard; the session revocation runs last, because it is what makes
  // any in-flight request fail and we want both blocks already in place when
  // the user's clients start reconnecting.
  async apply(input: ApplyBanInput): Promise<BanResult> {
    const user = await prisma.authUser.findUnique({
      where: { id: input.userId },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!user) {
      throw new NotFoundError("USER_NOT_FOUND");
    }

    // Fail-closed on the flag: if Redis is unreachable we must NOT report a
    // successful ban, because the flag is what stops community-service and
    // stream-service (neither of which consults sessions at all).
    await markUserBanned(redis, input.userId);

    await prisma.authUser.update({
      where: { id: input.userId },
      data: {
        status: AccountStatus.BANNED,
        // Reuses the existing suspended* columns rather than adding a parallel
        // banned* triple: they already mean "when/why/by whom was this account
        // restricted", and every read path treats them that way.
        suspendedAt: new Date(),
        suspendedReason: input.reason ?? null,
        // suspendedBy is @db.Uuid and an AdminUser.id is a different id space,
        // so the actor is recorded on the audit row instead of here. The
        // canonical actor record is backoffice's AuditLog.
        suspendedBy: null,
      },
    });

    const revokedSessions = await revokeEverySession(input.userId, "banned");

    // Tell every still-connected device why it is about to be disconnected.
    // Published before the gateway processes the session revokes above only by
    // convention — clients treat either arriving first as the same ban.
    void publishUserBanEvent(redis, input.userId, "user:banned", {
      type: "SYSTEM",
      userId: input.userId,
      reason: input.reason ?? null,
    }).catch(() => undefined);

    await authAuditService.record({
      event: "ACCOUNT_BANNED",
      targetType: "auth_user",
      targetId: input.userId,
      userId: input.userId,
      metadata: {
        actorAdminId: input.actorAdminId ?? null,
        reason: input.reason ?? null,
        previousStatus: user.status,
        revokedSessions,
      },
    });

    logger.info(
      `Account permanently banned: user=${input.userId} by=${input.actorAdminId ?? "(unknown)"} sessions=${String(revokedSessions)}`
    );

    return { status: AccountStatus.BANNED, revokedSessions };
  },

  // Lift a ban: login becomes possible again and nothing else is restored.
  //
  // Deliberately does NOT re-create community/group memberships the ban
  // removed, and does NOT reopen communities or groups that were closed
  // because this user owned them — those need their own administrative action.
  // Sessions cannot be un-revoked either; the user signs in fresh.
  async lift(input: ApplyBanInput): Promise<BanResult> {
    const user = await prisma.authUser.findUnique({
      where: { id: input.userId },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!user) {
      throw new NotFoundError("USER_NOT_FOUND");
    }

    // A deleted account is not a banned one — reinstating it here would
    // resurrect an account the user themselves asked to remove.
    if (user.deletedAt) {
      throw new NotFoundError("USER_NOT_FOUND");
    }

    await prisma.authUser.update({
      where: { id: input.userId },
      data: {
        status: AccountStatus.ACTIVE,
        suspendedAt: null,
        suspendedReason: null,
        suspendedBy: null,
      },
    });

    await clearUserBanned(redis, input.userId);

    void publishUserBanEvent(redis, input.userId, "user:unbanned", {
      type: "SYSTEM",
      userId: input.userId,
    }).catch(() => undefined);

    await authAuditService.record({
      event: "ACCOUNT_UNBANNED",
      targetType: "auth_user",
      targetId: input.userId,
      userId: input.userId,
      metadata: {
        actorAdminId: input.actorAdminId ?? null,
        previousStatus: user.status,
      },
    });

    logger.info(
      `Account ban lifted: user=${input.userId} by=${input.actorAdminId ?? "(unknown)"}`
    );

    return { status: AccountStatus.ACTIVE, revokedSessions: 0 };
  },

  // Shared with the RabbitMQ consumer's suspend branch, which must kill
  // sessions without touching the ban flag or the permanent status.
  revokeEverySession,
};
