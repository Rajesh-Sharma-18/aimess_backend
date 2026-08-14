import { logger } from "@aimess/logger";
import { isMandatoryAuditAction } from "@aimess/messaging";

import { redis } from "../config/redis.js";
import { PERMISSIONS } from "../constants/index.js";
import { auditLogRepository } from "../repositories/audit-log.repository.js";
import { rbacRepository } from "../repositories/rbac.repository.js";
import { publishAdminSocketEvent } from "./admin-socket-events.js";

/** Socket event carrying one newly-written audit row to open Audit Logs pages. */
export const AUDIT_LOG_CREATED_EVENT = "admin:audit-log:created";

const READERS_CACHE_KEY = "aimess:admin:auditlog-readers";
const READERS_CACHE_TTL_SECONDS = 30;

/**
 * Admin ids allowed to SEE audit logs. Authorization is enforced here, on the
 * server, by fanning out only to those admins' own `admin:<id>` channels — the
 * gateway then delivers to that admin's sockets and nobody else's. No broadcast
 * channel exists for anyone to subscribe to, so an admin without
 * `auditlogs.read` (and every end user) cannot receive the stream at all.
 *
 * Cached for 30s: audit rows arrive far more often than permission edits, and a
 * revoked admin loses the live feed within one TTL while the REST endpoint —
 * which is checked per request — rejects them immediately.
 */
async function auditLogReaderIds(): Promise<string[]> {
  try {
    const cached = await redis.get(READERS_CACHE_KEY);
    if (cached) return JSON.parse(cached) as string[];
  } catch {
    // Redis down — fall through to the direct lookup.
  }

  const ids = await rbacRepository.findActiveAdminIdsWithPermission(
    PERMISSIONS.AUDITLOGS_READ
  );

  try {
    await redis.set(
      READERS_CACHE_KEY,
      JSON.stringify(ids),
      "EX",
      READERS_CACHE_TTL_SECONDS
    );
  } catch {
    // Uncached is only slower, never wrong.
  }
  return ids;
}

/** Drop the cached reader set after a permission/role/status change. */
export async function invalidateAuditLogReaders(): Promise<void> {
  try {
    await redis.del(READERS_CACHE_KEY);
  } catch {
    // Stale for at most READERS_CACHE_TTL_SECONDS.
  }
}

/**
 * Push one committed audit row to every authorized admin's open panel.
 *
 * Called AFTER the insert commits, so a row that never landed can never appear
 * in the list. Never throws: a missed push costs a live update, and the action
 * being audited must not fail because Redis hiccuped.
 *
 * Non-mandatory actions are skipped — the default list does not show them, so
 * pushing one would cost a lookup per row for something no page renders.
 *
 * ponytail: resolves the performer per row (one PK read, plus a user-service
 * profile call for end-user actors) so the panel can render a name without a
 * round trip. Fine at admin-panel scale; if a high-volume action like
 * `user.login` ever makes this hot, batch rows on a short interval and resolve
 * performers once per batch.
 */
export async function emitAuditLogCreated(auditLogId: string): Promise<void> {
  try {
    // Cheapest guard first: nobody may read audit logs → nothing to resolve.
    const readers = await auditLogReaderIds();
    if (readers.length === 0) return;

    const detail = await auditLogRepository.getById(auditLogId);
    if (!detail || !isMandatoryAuditAction(detail.action)) return;

    // Exactly the list projection — the socket must not widen what the list
    // endpoint already exposes (before/after payloads stay behind GET /:id).
    const row = {
      id: detail.id,
      performer: detail.performer,
      source: detail.source,
      category: detail.category,
      action: detail.action,
      targetType: detail.targetType,
      targetId: detail.targetId,
      createdAt: detail.createdAt,
    };

    await Promise.all(
      readers.map((adminId) =>
        publishAdminSocketEvent(adminId, AUDIT_LOG_CREATED_EVENT, row)
      )
    );
  } catch (error) {
    logger.warn(`audit log realtime push failed (${auditLogId})`, error);
  }
}
