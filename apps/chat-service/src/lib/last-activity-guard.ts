/**
 * Monotonic ordering guard for the room's last-message snapshot.
 *
 * Every surface denormalizes its newest message onto the room document
 * (`lastMessageAt` + preview) so the inbox can order and preview conversations
 * without touching the message collection. Those writes are issued from
 * INDEPENDENT concurrent handlers — five messages typed in a burst are five
 * overlapping `sendMessage` promises, and community bumps additionally cross a
 * RabbitMQ queue consumed with `prefetch: 10`. Nothing guarantees the writes
 * land in send order, so an unguarded `update` lets message #4 overwrite
 * message #5's snapshot: the conversation list then shows an intermediate
 * message until the next refetch.
 *
 * The fix is to make the snapshot write CONDITIONAL on being newer than what is
 * already stored, ordered by `seq`:
 *
 *  - `stored.seq <= new.seq`   → newer (or the same row), accept
 *  - `stored.seq >  new.seq`   → stale, reject (no-op)
 *  - stored row carries NO seq → legacy, fall back to `lastMessageAt`
 *
 * `seq` is the per-room `sequenceNumber` (`allocateSequence`) and it — not
 * `createdAt` — is the room's ordering authority: the sequence comes from an
 * atomic `$inc` while `createdAt` is stamped a round trip later, so two
 * concurrent sends can genuinely swap between the two orderings (send A takes
 * seq 5 then writes createdAt .412; send B takes seq 6 then writes .408). The
 * clients render the transcript in `sequenceNumber` order (web
 * `component/chat/messages/messageOrder.ts` — "sequenceNumber is the
 * authority"), so a timestamp-ordered snapshot made the conversation list
 * preview a DIFFERENT message from the one at the bottom of the open chat.
 * `findPreviousVisible*` (the delete/clear recalculation) ranks by the same key
 * for the same reason.
 *
 * The `<=` is deliberate: an IN-PLACE refresh of the message the room already
 * points at (a call card transitioning RINGING→ENDED rewrites the same row with
 * its own `createdAt`/`seq`) must still land. Two DIFFERENT messages can never
 * share a `seq` — it is allocated by an atomic `$inc` — so `==` only ever means
 * "same message".
 *
 * This guard is for FORWARD bumps only. The delete/clear recalculation path
 * (`setLastMessage`, `rollbackLastActivity`) is the one legitimate BACKWARD
 * move, so it cannot use this predicate — it guards with `sameSnapshotWhere`
 * (compare-and-swap on the snapshot it read) instead.
 */

/** The legacy branch: a room row written before `lastMessageSeq` existed reads
 *  back as `null` on Prisma and is ABSENT in the document, and Mongo needs both
 *  spellings (see the `isSet` note in private-room.repository). */
type NoStoredSeq = [
  { lastMessageSeq: null },
  { lastMessageSeq: { isSet: false } },
];

export interface NewerSnapshotWhere {
  OR: (
    | { lastMessageSeq: { lte: number } }
    | {
        AND: [
          { OR: NoStoredSeq },
          { OR: [{ lastMessageAt: { lte: Date } }, { lastMessageAt: null }] },
        ];
      }
  )[];
}

/**
 * Prisma `where` fragment accepting only a snapshot newer than the stored one.
 * Spread into an `updateMany` alongside the row selector.
 *
 * `{ lastMessageAt: null }` on the legacy branch matches rooms that have never
 * had a message AND (on MongoDB) rooms whose document predates the column.
 */
export function newerSnapshotWhere(
  at: Date,
  seq: number | null | undefined
): NewerSnapshotWhere {
  return {
    OR: [
      { lastMessageSeq: { lte: seq ?? 0 } },
      {
        AND: [
          {
            OR: [
              { lastMessageSeq: null },
              { lastMessageSeq: { isSet: false } },
            ],
          },
          { OR: [{ lastMessageAt: { lte: at } }, { lastMessageAt: null }] },
        ],
      },
    ],
  };
}

/**
 * The same predicate as raw MongoDB query operators, for the one write issued
 * through `$runCommandRaw` (private's single-round-trip findAndModify, which
 * has to `$inc` unread and `$set` the snapshot in one atomic step). Raw Mongo
 * `{ field: null }` already matches an absent field, so the legacy branch needs
 * only the one spelling here.
 */
export function newerSnapshotMongoQuery(
  at: Date,
  seq: number | null | undefined
): Record<string, unknown> {
  const iso = at.toISOString();
  return {
    $or: [
      { lastMessageSeq: { $lte: seq ?? 0 } },
      {
        $and: [
          { lastMessageSeq: null },
          {
            $or: [
              { lastMessageAt: { $lte: { $date: iso } } },
              { lastMessageAt: null },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * The BACKWARD move's guard: compare-and-swap on the snapshot the caller read.
 *
 * A delete/expiry recalculation reads the room, resolves the newest surviving
 * message, then writes — three steps, no lock. Anything landing in between
 * (a new message, or a second recalculation from the same bulk auto-delete
 * sweep) makes that resolved value stale, and the unguarded write then pinned
 * the conversation list to a message that no longer exists or rewound it past a
 * message that just arrived. `newerSnapshotWhere` cannot be used here — a
 * recalculation is legitimately backward — so the predicate is identity
 * instead: only overwrite the exact snapshot the decision was made from.
 *
 * On MongoDB `{ field: null }` does NOT match a document where the field is
 * absent (see the `isSet` note in private-room.repository), so the empty-room
 * case has to accept both spellings or a room that never had a message could
 * never be CAS'd.
 */
export function sameSnapshotWhere(
  expectedLastMessageId: string | null | undefined
): Record<string, unknown> {
  return expectedLastMessageId
    ? { lastMessageId: expectedLastMessageId }
    : { OR: [{ lastMessageId: null }, { lastMessageId: { isSet: false } }] };
}

/**
 * How many read-decide-CAS passes a delete/expiry recalculation gets before it
 * gives up. Each refused swap means a strictly newer snapshot won, so the loop
 * converges; 3 covers a bulk auto-delete sweep colliding with a live send
 * without ever spinning on a genuinely hot room.
 */
export const RECALC_CAS_ATTEMPTS = 3;
