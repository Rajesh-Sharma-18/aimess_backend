/** View-model types for the Announcements admin API. */

export type AnnouncementTarget = "ALL" | "COMMUNITY";

export type AnnouncementStatus =
  | "SCHEDULED"
  | "PROCESSING"
  | "SENT"
  | "FAILED"
  | "CANCELLED";

/**
 * Which live device sessions receive the announcement. Resolved against the
 * PLATFORM of each recipient's device-token rows (one row per registered
 * session; revoked sessions have no row), never against a stored profile
 * preference.
 */
export type AnnouncementDeviceType = "ALL" | "ANDROID" | "IOS" | "WEB";

/** IMMEDIATE = deliver now; SCHEDULED = deliver at `scheduledAt`. */
export type AnnouncementType = "IMMEDIATE" | "SCHEDULED";

/**
 * Distinguishes the notification `type` delivered to recipients:
 * ANNOUNCEMENT (default, backward-compatible with the original single-purpose
 * feature), MAINTENANCE, or UPDATE_REQUIRED.
 */
export type AnnouncementKind =
  | "ANNOUNCEMENT"
  | "MAINTENANCE"
  | "UPDATE_REQUIRED";

/** A single row in the announcements table (list projection). */
export type AnnouncementListItem = {
  id: string;
  title: string;
  target: AnnouncementTarget;
  communityId: string | null;
  deviceType: AnnouncementDeviceType;
  recipientCount: number;
  status: AnnouncementStatus;
  scheduledAt: number | null;
  announcedAt: number; // sentAt when delivered, else createdAt
};

/** The full announcement detail returned by GET /announcements/{id}. */
export type AnnouncementDetail = {
  id: string;
  title: string;
  description: string;
  target: AnnouncementTarget;
  kind: AnnouncementKind;
  deviceType: AnnouncementDeviceType;
  communityId: string | null;
  status: AnnouncementStatus;
  scheduledAt: number | null;
  recipientCount: number;
  failureReason: string | null;
  createdById: string;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  cancelledAt: number | null;
};

/** Normalized create input (post-validation). */
export type CreateAnnouncementInput = {
  title: string;
  description: string;
  target: AnnouncementTarget;
  kind: AnnouncementKind;
  deviceType: AnnouncementDeviceType;
  announcementType: AnnouncementType;
  communityId?: string;
  scheduledAt?: string;
};

/** Normalized update input for a still-SCHEDULED announcement. */
export type UpdateAnnouncementInput = {
  title: string;
  description: string;
  deviceType: AnnouncementDeviceType;
  scheduledAt: string;
};

/** Normalized list query (post-validation/coercion). */
export type ListAnnouncementsQuery = {
  search?: string;
  target?: AnnouncementTarget;
  status?: AnnouncementStatus[];
  deviceType?: AnnouncementDeviceType;
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
