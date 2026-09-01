/**
 * Canonical "reports filed against this user" predicate.
 *
 * A report names its reported user in one of two columns, depending on type:
 *   - `type='user'`     → the user IS the target (`targetId`)
 *   - everything else   → the target is a message/stream/comment, and the
 *                         author is carried on `reportedUserId`
 *
 * `report.repository` already collapses the two on read
 * (`type === "user" ? targetId : reportedUserId`); User Management filtered on
 * `type='user'` alone, so a user reported only via a chat/community message
 * showed a report count of 0 and an empty "Reported Details" list while the
 * same rows were visible on the Reports screen.
 *
 * The `type: { not: "user" }` guard on the second branch keeps the two
 * branches disjoint, so a row can never be counted twice.
 */
export function reportsAgainstUser(userId: string) {
  return {
    OR: [
      { type: "user", targetId: userId },
      { type: { not: "user" }, reportedUserId: userId },
    ],
  };
}

/** Same predicate widened to a set of users (list/bulk aggregation). */
export function reportsAgainstUsers(userIds: string[]) {
  return {
    OR: [
      { type: "user", targetId: { in: userIds } },
      { type: { not: "user" }, reportedUserId: { in: userIds } },
    ],
  };
}
