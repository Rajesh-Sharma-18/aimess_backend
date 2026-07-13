import { logger } from "@aimess/logger";

import { authAuditLogRepository } from "../repositories/auth-audit-log.repository.js";

/**
 * The full QR-login lifecycle taxonomy plus the two linked-device events —
 * one enum, so every call site is grep-able and nothing silently invents a
 * new event string.
 */
export type AuthAuditEvent =
  | "QR_CREATED"
  | "QR_SCANNED"
  | "QR_APPROVED"
  | "QR_REJECTED"
  | "QR_EXPIRED"
  | "BROWSER_LOGGED_IN"
  | "LINKED_DEVICE_CREATED"
  | "LINKED_DEVICE_REVOKED";

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
