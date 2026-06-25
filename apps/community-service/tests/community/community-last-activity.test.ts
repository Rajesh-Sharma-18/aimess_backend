/**
 * Suite: community-last-activity (buildLastActivity preview rule)
 *
 * Pins the Telegram-parity rule for the community-list `lastActivity` preview
 * surfaced by EVERY list/summary surface (`/communities/mine`, search/discover,
 * get-by-id, and the socket bumps which reuse the same DTO):
 *
 *   - SYSTEM / lifecycle activities (created/system/join/removal/pinned/unpinned)
 *     are shown STANDALONE — `username` is ALWAYS null so the client never
 *     renders a "<actor>: <system text>" prefix. This is the exact bug:
 *     "Rajesh: John Doe became moderator" must become "John Doe became moderator".
 *
 *   - USER messages (message/reaction/edited/deleted) keep the sender so the
 *     client can render "<sender>: <preview>" / "You: <preview>" exactly as today.
 *
 * Pure-function test — `buildLastActivity` is exported from community.service.ts.
 * The global-mocks.ts setup stubs every I/O boundary so importing the service is
 * side-effect-free.
 */

import { buildLastActivity } from "../../src/services/community.service.js";

const CREATED_AT = new Date("2026-06-01T00:00:00.000Z");
const ACTIVITY_AT = new Date("2026-06-19T12:00:00.000Z");

/** A community row as read for the list, with a populated actor column so each
 *  test proves the stored username is STRIPPED for system activities. */
function row(overrides: {
  lastActivityType?: string | null;
  lastActivityPreview?: string | null;
  lastActivityUsername?: string | null;
  lastActivityUserId?: string | null;
}) {
  return {
    createdAt: CREATED_AT,
    lastActivityAt: ACTIVITY_AT,
    lastActivityUsername: "Rajesh", // a non-null actor on every row by default
    lastActivityUserId: "actor-1",
    ...overrides,
  };
}

describe("buildLastActivity — SYSTEM activities are NEVER sender-prefixed", () => {
  // Each entry: [scenario, lastActivityType, stored preview sentence]
  const SYSTEM_CASES: Array<[string, string, string]> = [
    ["Community Created", "created", "Community created"],
    ["Community Updated", "system", "Community info was updated"],
    ["Community Avatar Updated", "system", "Community photo updated"],
    ["Community Name Changed", "system", "Community name was changed"],
    ["Role Changed (admin)", "system", "John Doe became admin"],
    ["Role Changed (moderator)", "system", "John Doe became moderator"],
    ["Member Joined", "join", "John Doe joined the community"],
    // NOTE: "removal" is no longer a standalone preview — it is suppressed to the
    // "created" fallback (see the dedicated eligibility suite below).
    ["Member Banned", "system", "John Doe was banned"],
    ["Member Unbanned", "system", "John Doe was unbanned"],
    ["Pinned", "pinned", "John Doe pinned a message"],
    ["Unpinned", "unpinned", "John Doe unpinned a message"],
  ];

  it.each(SYSTEM_CASES)(
    "[%s] returns username: null and the preview standalone (no prefix)",
    (_scenario, type, preview) => {
      const result = buildLastActivity(
        row({ lastActivityType: type, lastActivityPreview: preview })
      );

      // The core guarantee: NO sender prefix is possible because username is null,
      // even though the stored actor column held "Rajesh".
      expect(result.userId).toBeNull();
      expect(result.username).toBeNull();
      expect(result.preview).toBe(preview);
      // The preview itself must not contain a "<name>: " prefix.
      expect(result.preview).not.toMatch(/^Rajesh: /);
    }
  );

  it("preserves the SYSTEM type discriminant (system/join/pinned/unpinned)", () => {
    expect(buildLastActivity(row({ lastActivityType: "join" })).type).toBe(
      "join"
    );
    expect(buildLastActivity(row({ lastActivityType: "system" })).type).toBe(
      "system"
    );
    expect(buildLastActivity(row({ lastActivityType: "pinned" })).type).toBe(
      "pinned"
    );
  });

  it("created uses createdAt for dateTime; other system types use lastActivityAt", () => {
    expect(
      buildLastActivity(row({ lastActivityType: "created" })).dateTime
    ).toBe(CREATED_AT.getTime());
    expect(buildLastActivity(row({ lastActivityType: "join" })).dateTime).toBe(
      ACTIVITY_AT.getTime()
    );
  });

  it("unknown / legacy activity types collapse to a sender-less 'created' shape", () => {
    const result = buildLastActivity(
      row({ lastActivityType: "totally-unknown", lastActivityPreview: null })
    );
    expect(result.type).toBe("created");
    expect(result.userId).toBeNull();
    expect(result.username).toBeNull();
    expect(result.preview).toBe("Community created");
  });

  it("null lastActivityType defaults to the sender-less 'created' shape", () => {
    const result = buildLastActivity(
      row({ lastActivityType: null, lastActivityPreview: null })
    );
    expect(result.type).toBe("created");
    expect(result.userId).toBeNull();
    expect(result.username).toBeNull();
  });
});

describe("buildLastActivity — USER messages KEEP the sender prefix (unchanged)", () => {
  it.each(["message", "reaction", "edited", "deleted"])(
    "[%s] keeps username so the client renders '<sender>: <preview>'",
    (type) => {
      const result = buildLastActivity(
        row({
          lastActivityType: type,
          lastActivityUsername: "John",
          lastActivityPreview: "Hello",
        })
      );
      expect(result.type).toBe(type);
      expect(result.username).toBe("John");
      expect(result.preview).toBe("Hello");
      expect(result.dateTime).toBe(ACTIVITY_AT.getTime());
    }
  );

  it("a TEXT message with a missing username degrades to '' (never null)", () => {
    const result = buildLastActivity(
      row({
        lastActivityType: "message",
        lastActivityUsername: null,
        lastActivityPreview: "Hi",
      })
    );
    expect(result.username).toBe("");
  });
});

describe("buildLastActivity — ineligible lifecycle activity is suppressed", () => {
  it("a legacy 'removal' row never surfaces the removal text (falls back to 'created')", () => {
    const result = buildLastActivity(
      row({
        lastActivityType: "removal",
        lastActivityPreview: "Jim Methews was removed from the community",
        lastActivityUsername: "Admin",
      })
    );

    // The exact screenshot bug: "Jim Methews was removed from the community" must
    // NOT be the lastActivity. We can't recover the prior eligible message from
    // the single column, so Case 4 fallback = the sender-less "created" baseline.
    expect(result.preview).toBe("Community created");
    expect(result.type).toBe("created");
    expect(result.username).toBeNull();
    expect(result.dateTime).toBe(CREATED_AT.getTime());
  });
});
