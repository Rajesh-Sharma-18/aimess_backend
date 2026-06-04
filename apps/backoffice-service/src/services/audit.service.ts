import type { Prisma } from "../generated/prisma/client.js";
import {
  auditLogRepository,
  type AuditLogInput,
} from "../repositories/index.js";

export const auditService = {
  /**
   * Append an audit row (hot path — always synchronous so it can never be lost).
   * Pass a transaction client to share the domain mutation's transaction.
   */
  record(input: AuditLogInput, client?: Prisma.TransactionClient) {
    return auditLogRepository.create(input, client);
  },
};
