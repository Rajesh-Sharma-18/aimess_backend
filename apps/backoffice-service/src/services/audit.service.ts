import type { Prisma } from "../generated/prisma/client.js";
import {
  auditLogRepository,
  type AuditLogInput,
} from "../repositories/index.js";
import type {
  AuditLogDetail,
  AuditLogListItem,
  ListAuditLogsQuery,
  Paginated,
} from "../types/audit-log.types.js";
import { emitAuditLogCreated } from "../lib/audit-realtime.js";

export const auditService = {
  /**
   * Append an audit row (hot path — always synchronous so it can never be lost).
   * Pass a transaction client to share the domain mutation's transaction.
   */
  async record(input: AuditLogInput, client?: Prisma.TransactionClient) {
    const row = await auditLogRepository.create(input, client);
    // Live push to open Audit Logs pages. Fire-and-forget: the moderation action
    // this records must not fail because a socket push did.
    void emitAuditLogCreated(row.id);
    return row;
  },

  /** Paginated + filtered audit-log list (read side of the admin panel). */
  listAuditLogs(
    query: ListAuditLogsQuery
  ): Promise<Paginated<AuditLogListItem>> {
    return auditLogRepository.list(query);
  },

  /** Fetch one audit log; null is translated to 404 by the controller. */
  getAuditLog(id: string): Promise<AuditLogDetail | null> {
    return auditLogRepository.getById(id);
  },
};
