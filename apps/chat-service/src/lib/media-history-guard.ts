import { ForbiddenError } from "@aimess/errors";

import {
  getGroupVisibilityCutoff,
  isHiddenByCutoff,
} from "./deletion-cutoff.js";

/** The one repository question this guard asks, kept as a function so the
 *  guard can be exercised without a database. */
export type VisibleObjectKeyProbe = (params: {
  roomId: string;
  objectKey: string;
  cutoff: Date;
}) => Promise<boolean>;

/**
 * A group attachment is only downloadable by a member whose own history
 * contains the message carrying it.
 *
 * Membership alone used to be the whole answer, which made an objectKey a way
 * around the history boundary: a member who joined today, handed (or guessing)
 * the key of a years-old attachment, got a presigned URL for it — while the
 * timeline, search, media list and pins all refuse them the message it belongs
 * to.
 *
 * Two facts decide it, in this order, so the common case costs nothing:
 *
 *   1. No boundary (a founding member, no clear) → nothing to enforce.
 *   2. Uploaded AFTER the boundary → its message is too; a send always follows
 *      its own upload. Allowed without touching the messages collection.
 *   3. Otherwise the object predates the boundary, and the only thing that can
 *      still make it legitimate is a message the caller MAY read that carries
 *      it — the straddle where a long upload finished before they joined and
 *      the send landed after. That one case is worth the query; comparing
 *      timestamps alone would refuse it forever and leave a permanently broken
 *      attachment on screen.
 *
 * Fail-closed by construction: anything not proven readable is refused.
 */
export async function assertGroupMediaWithinHistory(params: {
  member: {
    joinedAt?: Date | null;
    clearedAt?: Date | null;
    clearChatAt?: Date | null;
  } | null;
  roomId: string;
  /** Empty when the caller did not supply one (upload path, older client). */
  objectKey: string;
  /** Epoch ms; 0/absent means "not supplied". */
  objectCreatedAtMs: number;
  probe: VisibleObjectKeyProbe;
}): Promise<void> {
  const cutoff = getGroupVisibilityCutoff(params.member);
  if (!cutoff) return;
  // Nothing to reason about — keep the pre-existing membership-only answer
  // rather than refusing a download an older media-service cannot describe.
  if (!params.objectKey || params.objectCreatedAtMs <= 0) return;
  if (!isHiddenByCutoff(new Date(params.objectCreatedAtMs), cutoff)) return;

  const visible = await params.probe({
    roomId: params.roomId,
    objectKey: params.objectKey,
    cutoff,
  });
  if (!visible) throw new ForbiddenError("CHAT_MESSAGE_BEFORE_JOIN");
}
