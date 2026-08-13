/**
 * Replays this service's existing history into the admin panel's audit log.
 *
 * The live pipeline only records what happens after it was deployed, so the Audit Logs
 * screen shows no account activity until someone signs in. This publishes the history
 * already persisted here through the SAME queue the live path uses, so backoffice's
 * consumer writes it with identical shape and validation.
 *
 * Idempotent: every row carries a deterministic `backfill:` eventId and the consumer
 * swallows duplicate inserts, so re-running changes nothing.
 *
 * DRY RUN by default — prints what it would publish. Pass `--apply` to publish.
 *
 * Usage: pnpm --filter @aimess/auth-service exec tsx scripts/backfill-audit-activity.ts [--apply]
 */
import {
  backfillEventId,
  closeAdminActivityPublisher,
  publishAdminActivity,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";

import { prisma } from "../src/config/prisma.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 500;

/**
 * Replay only what happened BEFORE the live pipeline started publishing, otherwise a row
 * recorded live and the same row replayed here both land (different eventIds, so the
 * unique index cannot collapse them). Pass the deploy timestamp:
 * `--until=2026-08-13T06:25:00.000Z`. Default: everything.
 */
const untilArg = process.argv
  .find((a) => a.startsWith("--until="))
  ?.slice("--until=".length);
const UNTIL = untilArg ? new Date(untilArg) : null;
if (untilArg && Number.isNaN(UNTIL?.getTime())) {
  throw new Error(`--until is not a valid date: ${untilArg}`);
}

// Only this auth-audit event is worth replaying; the rest of that table is QR lifecycle
// churn (~18k QR_CREATED/QR_EXPIRED rows) or a duplicate of a better source —
// LINKED_DEVICE_CREATED repeats every Session row, and ACCOUNT_DELETED repeats
// AuthUser.deletedAt.
const AUTH_AUDIT_ACTIONS: Record<string, string> = {
  QR_LOGIN_SUCCESS: USER_AUDIT_ACTIONS.USER_DEVICE_LINKED,
};

/**
 * A revoked session is either the user signing themselves out, the user killing another
 * device, or the platform pulling it. Bulk fan-out reasons are deliberately absent:
 * PASSWORD_CHANGED and ACCOUNT_DELETED revoke every session at once, so replaying them
 * would emit N rows for ONE user action — the live publishers emit a single row carrying
 * `revokedSessions`. ADMIN_REVOKED is an admin action backoffice already records itself.
 */
const REVOKE_ACTIONS: Record<string, { action: string; system?: boolean }> = {
  USER_SIGNED_OUT: { action: USER_AUDIT_ACTIONS.USER_LOGOUT },
  REMOTE_SIGNOUT: { action: USER_AUDIT_ACTIONS.USER_SESSION_REVOKED },
  // Platform-initiated: the user did not do this, so it is not attributed to them.
  TOKEN_REUSE_DETECTED: {
    action: USER_AUDIT_ACTIONS.USER_SESSION_REVOKED,
    system: true,
  },
  SUSPICIOUS_ACTIVITY: {
    action: USER_AUDIT_ACTIONS.USER_SESSION_REVOKED,
    system: true,
  },
};

const counts = new Map<string, number>();
let published = 0;

async function emit(input: {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  eventId: string;
  eventAt: Date;
  after?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  system?: boolean;
}): Promise<void> {
  if (UNTIL && input.eventAt >= UNTIL) return;
  counts.set(input.action, (counts.get(input.action) ?? 0) + 1);
  if (!APPLY) return;
  await publishAdminActivity({
    // A platform-initiated revoke has no user actor; actorType must be explicit because
    // the publisher otherwise infers USER from a present actorId.
    actorId: input.system ? null : input.actorId,
    actorType: input.system ? "SYSTEM" : "USER",
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    after: input.after,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    eventAt: input.eventAt.toISOString(),
    eventId: input.eventId,
  });
  published++;
}

// 1. Registrations.
async function backfillRegistrations(): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.authUser.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: { id: true, account: true, createdAt: true, deletedAt: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      await emit({
        actorId: row.id,
        action: USER_AUDIT_ACTIONS.USER_REGISTERED,
        targetType: "user",
        targetId: row.id,
        eventId: backfillEventId("auth-user", row.id, "registered"),
        eventAt: row.createdAt,
        after: { account: row.account },
      });
      if (row.deletedAt) {
        await emit({
          actorId: row.id,
          action: USER_AUDIT_ACTIONS.USER_ACCOUNT_DELETED,
          targetType: "user",
          targetId: row.id,
          eventId: backfillEventId("auth-user", row.id, "deleted"),
          eventAt: row.deletedAt,
        });
      }
    }
  }
}

// 2. Every session row is one login; its revocation is a second event.
async function backfillSessions(): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.session.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        userId: true,
        deviceType: true,
        deviceName: true,
        countryCode: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        revokedAt: true,
        revokedReason: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      await emit({
        actorId: row.userId,
        action: USER_AUDIT_ACTIONS.USER_LOGIN,
        targetType: "session",
        targetId: row.id,
        eventId: backfillEventId("auth-session", row.id, "login"),
        eventAt: row.createdAt,
        after: {
          deviceType: row.deviceType,
          deviceName: row.deviceName,
          countryCode: row.countryCode,
        },
        ip: row.ipAddress,
        userAgent: row.userAgent,
      });

      const revoke = row.revokedReason
        ? REVOKE_ACTIONS[row.revokedReason]
        : undefined;
      if (row.revokedAt && revoke) {
        await emit({
          actorId: row.userId,
          action: revoke.action,
          system: revoke.system,
          targetType: "session",
          targetId: row.id,
          eventId: backfillEventId("auth-session", row.id, "revoked"),
          eventAt: row.revokedAt,
          after: { reason: row.revokedReason, userId: row.userId },
          ip: row.ipAddress,
          userAgent: row.userAgent,
        });
      }
    }
  }
}

// 3. QR device links — the one auth-audit event with no better source.
async function backfillAuthAudit(): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.authAuditLog.findMany({
      where: {
        event: { in: Object.keys(AUTH_AUDIT_ACTIONS) },
        userId: { not: null },
      },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      await emit({
        actorId: row.userId as string,
        action: AUTH_AUDIT_ACTIONS[row.event],
        targetType: row.targetType,
        targetId: row.targetId ?? row.id,
        eventId: backfillEventId("auth-audit", row.id),
        eventAt: row.createdAt,
        after: { event: row.event },
        ip: row.ipAddress,
        userAgent: row.userAgent,
      });
    }
  }
}

async function main(): Promise<void> {
  await backfillRegistrations();
  await backfillSessions();
  await backfillAuthAudit();

  const planned = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(APPLY ? "PUBLISHED" : "DRY RUN — would publish");
  for (const [action, n] of planned)
    console.log(`  ${n.toString().padStart(6)}  ${action}`);
  console.log(
    `  total=${planned.reduce((sum, [, n]) => sum + n, 0)}${APPLY ? ` publishedToBroker=${published}` : ""}`
  );
  if (!APPLY) console.log("Re-run with --apply to publish.");

  await closeAdminActivityPublisher();
  await prisma.$disconnect();
}

await main();
