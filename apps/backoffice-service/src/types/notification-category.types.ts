/**
 * Super Admin notification-category catalogue.
 *
 * Configuration only. There is no create and no delete type here because there
 * is no create and no delete operation: the six categories are seeded by
 * chat-service and their ids are a persisted client contract, so the panel can
 * change a row's `priority` and its per-platform enablement and nothing else.
 */
/**
 * How many categories the fixed catalogue holds — and therefore the highest
 * priority that means anything. Kept here rather than imported from
 * chat-service (separate service, separate deployable); the seed that owns the
 * six rows lives there and the count is part of the contract between them.
 */
export const NOTIFICATION_CATEGORY_COUNT = 6;

export type NotificationPlatform = "ANDROID" | "IOS" | "WEB";

export interface NotificationCategoryRow {
  /** Stable, uppercase, never renamed or reused. Shown in the grid as-is. */
  id: string;
  priority: number;
  /** English fallback label — owned by code, not editable from the panel. */
  defaultLabel: string;
  /** Client-side asset key — owned by code, not editable from the panel. */
  iconKey: string;
  enabledPlatforms: NotificationPlatform[];
  updatedAt: number;
}

export interface UpdateNotificationCategoryInput {
  priority?: number;
  enabledPlatforms?: NotificationPlatform[];
}
