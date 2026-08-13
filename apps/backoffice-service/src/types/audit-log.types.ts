/**
 * View-model types for the Audit Logs admin API (read-only).
 *
 * The write side already exists (auditService.record → AuditLog rows). These
 * shapes are what the list/detail read endpoints project the persisted
 * `AuditLog` rows into. Field names + casing are the stable API contract.
 */

import type { MediaObject } from "@aimess/shared-types";

// Which side of the platform the actor belongs to.
export type AuditActorKind = "ADMIN" | "USER" | "SYSTEM";

/** Who performed the action (admin table, user-service profile, or nobody for SYSTEM). */
export type AuditPerformer = {
  // AdminUser.id / AuthUser.id; null for SYSTEM rows.
  id: string | null;
  // Tells the UI whether this row came from the admin panel or the website.
  type: AuditActorKind;
  /** Display name; null when the actor row was removed or unresolvable. */
  name: string | null;
  /** Admin email, or the end user's username; null when unresolvable. */
  email: string | null;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // no avatar is set. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
};

/** A single row in the audit-logs table (list projection). */
export type AuditLogListItem = {
  id: string;
  performer: AuditPerformer;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: number;
};

/** The full audit-log detail returned by GET /audit-logs/{id}. */
export type AuditLogDetail = {
  id: string;
  performer: AuditPerformer;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: number;
  /** Best-effort human reason, lifted from the before/after payload if present. */
  reason: string | null;
  metadata: {
    before: unknown;
    after: unknown;
    ip: string | null;
    userAgent: string | null;
  };
};

/** Normalized list query (post-validation/coercion). */
export type ListAuditLogsQuery = {
  search?: string;
  action?: string[];
  // ADMIN = admin-panel action, USER = website action, SYSTEM = platform job.
  actorType?: AuditActorKind[];
  dateFrom?: string;
  dateTo?: string;
  sort: string;
  page: number;
  limit: number;
};

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

export type Paginated<T> = {
  data: T[];
  pagination: PaginationMeta;
};
