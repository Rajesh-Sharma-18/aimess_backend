import {
  shouldCountInUnread,
  UNREAD_COUNTABLE_EVENT_RAW_MATCH,
} from "../../src/lib/unread-count.js";

/**
 * The writer decides countability with {@link shouldCountInUnread}; every
 * recount decides it again in a Mongo `$match`. When those two disagree the
 * stored unread counter becomes unreconcilable — the `$inc` that credited a row
 * can never be undone by a recount that filters the same row out — and the nav
 * badge keeps an unread conversation forever. That is the bug this pins shut, so
 * the two definitions are asserted to classify identical documents identically.
 *
 * The evaluator below covers only the operators the match actually uses, with
 * Mongo's own semantics for each: `$ne` and `{field: null}` are true for a
 * MISSING field, `$in` is not.
 */
type Doc = {
  messageType?: string;
  systemEvent?: string | null;
  countInUnread?: boolean;
};

function matches(clause: unknown, doc: Doc): boolean {
  const node = clause as Record<string, unknown>;
  if (Array.isArray(node.$and))
    return node.$and.every((c) => matches(c, doc));
  if (Array.isArray(node.$or)) return node.$or.some((c) => matches(c, doc));

  return Object.entries(node).every(([field, expected]) => {
    const present = Object.prototype.hasOwnProperty.call(doc, field);
    const actual = (doc as Record<string, unknown>)[field];
    if (expected !== null && typeof expected === "object") {
      const op = expected as Record<string, unknown>;
      if ("$ne" in op) return !present || actual !== op.$ne;
      if ("$exists" in op) return present === op.$exists;
      if ("$in" in op)
        return present && (op.$in as unknown[]).includes(actual as never);
      throw new Error(`unsupported operator in ${JSON.stringify(op)}`);
    }
    // A literal null matches null OR a missing field.
    if (expected === null) return !present || actual === null;
    return present && actual === expected;
  });
}

const DOCS: Doc[] = [
  // Ordinary messages, with and without a persisted verdict.
  { messageType: "TEXT", systemEvent: null, countInUnread: true },
  { messageType: "TEXT", systemEvent: null },
  { messageType: "TEXT" },
  { messageType: "IMAGE", systemEvent: null, countInUnread: false },
  // Audit lines — never countable, whatever the subtype.
  { messageType: "SYSTEM", systemEvent: "MEMBER_ADDED", countInUnread: false },
  { messageType: "SYSTEM", systemEvent: "MESSAGE_PINNED" },
  { messageType: "SYSTEM", systemEvent: "FRIENDSHIP_CREATED" },
  // Call rows: a lifecycle marker on a non-SYSTEM kind.
  { messageType: "VOICE_CALL", systemEvent: "CALL_ENDED", countInUnread: false },
  { messageType: "VIDEO_CALL", systemEvent: "CALL_MISSED" },
  // Invitation cards — addressed content wearing a system marker. These are the
  // rows the old hand-rolled filter dropped.
  { messageType: "SYSTEM", systemEvent: "COMMUNITY_INVITE" },
  { messageType: "SYSTEM", systemEvent: "GROUP_INVITE" },
  // …and the same cards persisted under the OLDER policy, which said no.
  { messageType: "SYSTEM", systemEvent: "COMMUNITY_INVITE", countInUnread: false },
  { messageType: "SYSTEM", systemEvent: "GROUP_INVITE", countInUnread: false },
  { messageType: "SYSTEM", systemEvent: "COMMUNITY_INVITE", countInUnread: true },
];

describe("UNREAD_COUNTABLE_EVENT_RAW_MATCH mirrors shouldCountInUnread", () => {
  for (const doc of DOCS) {
    it(`agrees on ${JSON.stringify(doc)}`, () => {
      expect(matches(UNREAD_COUNTABLE_EVENT_RAW_MATCH, doc)).toBe(
        shouldCountInUnread({
          messageType: doc.messageType,
          systemEvent: doc.systemEvent,
          explicit: doc.countInUnread,
        })
      );
    });
  }

  it("counts an invite card the old filter dropped", () => {
    const invite: Doc = {
      messageType: "SYSTEM",
      systemEvent: "COMMUNITY_INVITE",
    };
    expect(matches(UNREAD_COUNTABLE_EVENT_RAW_MATCH, invite)).toBe(true);
    // What the replaced filter did: a blanket SYSTEM/systemEvent exclusion.
    expect(
      matches({ messageType: { $ne: "SYSTEM" }, systemEvent: null }, invite)
    ).toBe(false);
  });

  it("still refuses an invite card whose persisted verdict says no", () => {
    expect(
      matches(UNREAD_COUNTABLE_EVENT_RAW_MATCH, {
        messageType: "SYSTEM",
        systemEvent: "GROUP_INVITE",
        countInUnread: false,
      })
    ).toBe(false);
  });
});
