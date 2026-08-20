/**
 * Notification copy moved to `@aimess/constants` so the READ side (chat-service's
 * notification serializer, the gateway `/notify` relay) can replay the same
 * builders and re-render a stored row in the reader's CURRENT language.
 *
 * Re-exported from the old path because nothing about the write side changed —
 * consumers still build copy exactly as before.
 */
export {
  friendCopy,
  communityCopy,
  chatCopy,
  chatPreviewHiddenBody,
  groupCopy,
  callCopy,
  authCopy,
  resolutionCopy,
  renderNotificationCopy,
  renderNotificationData,
  COPY_REF_KEY,
  DATA_REF_KEY,
} from "@aimess/constants";
export type {
  NotificationCopy,
  LocalizedCopy,
  LocalizedData,
  CopyDescriptor,
} from "@aimess/constants";
