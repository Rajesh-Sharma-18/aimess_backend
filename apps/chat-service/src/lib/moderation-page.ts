/**
 * One page (or jump window) of a conversation, as the read-only Backoffice
 * conversation viewer sees it.
 *
 * Group history is keyset-paged on `sequenceNumber` and community history on a
 * compound `"<createdAtMs>_<id>"` timestamp cursor, but the admin viewer drives
 * both through one `navigateToMessage` mechanism, so both moderation reads
 * return this same envelope and the cursors stay opaque to the caller.
 */
export interface ModerationMessagePage {
  items: Array<Record<string, unknown>>;
  /** A history page older than `items[0]` exists. */
  hasMore: boolean;
  /** Feed back as `cursor` to page older; null when history starts here. */
  nextCursor: string | null;
  /** A history page newer than the last item exists (only after a jump). */
  hasMoreNewer: boolean;
  /** Feed back as `cursor` with `direction=after` to page newer. */
  newerCursor: string | null;
  /**
   * Only set by an `aroundMessageId` read: false when the anchor message is
   * gone (deleted for everyone, auto-deleted, or never existed in this room),
   * so the viewer can show its unavailable state instead of scrolling nowhere.
   */
  found?: boolean;
}

export const EMPTY_MODERATION_PAGE: ModerationMessagePage = {
  items: [],
  hasMore: false,
  nextCursor: null,
  hasMoreNewer: false,
  newerCursor: null,
};
