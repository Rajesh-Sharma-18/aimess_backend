import { logger } from "@aimess/logger";

import { authAuditLogRepository } from "../repositories/auth-audit-log.repository.js";

/**
 * The full QR-login lifecycle taxonomy plus the two linked-device events —
 * one enum, so every call site is grep-able and nothing silently invents a
 * new event string. Telegram-style instant login (scan IS login, no
 * approve/reject step): QR_LOGIN_ATTEMPT fires when a scan is claimed,
 * QR_LOGIN_SUCCESS when tokens are issued, QR_REUSED_ATTEMPT when a
 * second scan hits an already-claimed/used QR. QR_CANCELLED fires when a
 * prior PENDING session is superseded by a new QR from the same device
 * (WhatsApp-like one-active-session-per-device replacement).
 */
export type AuthAuditEvent =
  | "QR_CREATED"
  | "QR_CANCELLED"
  | "QR_LOGIN_ATTEMPT"
  | "QR_LOGIN_SUCCESS"
  | "QR_REUSED_ATTEMPT"
  | "QR_EXPIRED"
  | "BROWSER_LOGGED_IN"
  | "LINKED_DEVICE_CREATED"
  | "LINKED_DEVICE_REVOKED"
  | "ACCOUNT_DELETED"
  // Super Admin reactivation of a soft-deleted account (the inverse of
  // ACCOUNT_DELETED). Distinct from ACCOUNT_UNBANNED: an unban lifts a
  // restriction, this un-deletes the account itself.
  | "ACCOUNT_RESTORED"
  // Permanent Super Admin ban. auth-service's own trail — backoffice's AuditLog
  // is the canonical admin-facing record, but its actorId is an FK to AdminUser
  // so it cannot express what happened to the end-user account itself.
  | "ACCOUNT_BANNED"
  | "ACCOUNT_UNBANNED"
  // The 30-day grace period elapsed and the account's personal data was
  // ERASED. Distinct from ACCOUNT_DELETED, which is reversible and overwrites
  // nothing; this one is terminal and is the record that the erasure actually
  // happened — the only proof left, since the data it refers to is gone.
  | "ACCOUNT_PURGED";

export interface RecordAuditEventInput {
  event: AuthAuditEvent;
  targetType: string;
  targetId?: string | null;
  userId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export const authAuditService = {
  async record(input: RecordAuditEventInput): Promise<void> {
    try {
      await authAuditLogRepository.create(input);
    } catch (err) {
      logger.error(`Failed to persist audit event ${input.event}`);
      logger.error(err);
    }
  },
};

/**
 * Fire-and-forget: audit persistence must never fail or delay the caller's
 * request (a QR approval/login must succeed even if the audit DB write hiccups).
 */
export function recordAuditEventSafe(input: RecordAuditEventInput): void {
  void authAuditService.record(input);
}
