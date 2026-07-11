/** View-model types for the Announcements admin API. */

export type AnnouncementTarget = "ALL" | "COMMUNITY";

export type AnnouncementStatus = "SCHEDULED" | "PROCESSING" | "SENT" | "FAILED";

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
  recipientCount: number;
  status: AnnouncementStatus;
  announcedAt: number; // sentAt when delivered, else createdAt
};

/** The full announcement detail returned by GET /announcements/{id}. */
export type AnnouncementDetail = {
  id: string;
  title: string;
  description: string;
  target: AnnouncementTarget;
  kind: AnnouncementKind;
  communityId: string | null;
  status: AnnouncementStatus;
  scheduledAt: number | null;
  recipientCount: number;
  failureReason: string | null;
  createdById: string;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
};

/** Normalized create input (post-validation). */
export type CreateAnnouncementInput = {
  title: string;
  description: string;
  target: AnnouncementTarget;
  kind: AnnouncementKind;
  communityId?: string;
  scheduledAt?: string;
};

/** Normalized list query (post-validation/coercion). */
export type ListAnnouncementsQuery = {
  search?: string;
  target?: AnnouncementTarget;
  status?: AnnouncementStatus[];
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
