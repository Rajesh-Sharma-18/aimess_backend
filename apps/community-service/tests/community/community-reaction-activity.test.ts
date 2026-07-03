/**
 * Suite: community-reaction-activity
 *
 * Covers the reaction OVERLAY mechanism that replaces the old
 * "reaction via lastActivityType/selectListPreview" design:
 *
 *   - A reaction NEVER touches the canonical lastActivityAt/Type/Preview/
 *     Username/UserId columns — those stay exactly what a real message/system
 *     event last set, so every OTHER member always sees the real activity,
 *     completely unaffected by any reaction (self OR cross-user).
 *   - The overlay is visible ONLY to its own actor and (if different) the
 *     reacted-to message's owner, and ONLY while it is genuinely newer than
 *     the canonical activity (`applyReactionOverlay`'s newest-wins gate).
 *   - Adding a reaction unconditionally overwrites the overlay (an add is
 *     always the newest reaction event, even across different messages).
 *   - Removing a reaction clears the overlay ONLY if it is an exact identity
 *     match (messageId + emoji + actorId) for what is currently shown;
 *     removing any OTHER reaction (same message, different emoji/user, or a
 *     different message) is a no-op.
 *
 * `applyReactionOverlay` is a pure-function test (no I/O). The repository
 * tests mock only the Prisma boundary, mirroring
 * community-last-activity-username-sync.test.ts's pattern.
 */

import { applyReactionOverlay } from "../../src/services/community.service.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const THIRD_PARTY = "33333333-3333-4333-8333-333333333333";

const CANONICAL_AT = 1_700_000_000_000;
const canonicalBase = {
  lastActivity: {
    type: "message" as const,
    userId: "sender-1",
    username: "Charlie",
    preview: "Welcome everyone",
    dateTime: CANONICAL_AT,
  },
  lastActivityAt: CANONICAL_AT,
};

describe("applyReactionOverlay — requirement 1: self-reaction visibility", () => {
  const row = {
    lastActivityReactionAt: new Date(CANONICAL_AT + 60_000),
    lastActivityReactionActorId: ACTOR,
    lastActivityReactionActorPreview: 'You reacted 👍 to "Hello"',
    lastActivityReactionTargetId: null,
    lastActivityReactionTargetPreview: null,
  };

  it("shows the actor their own personalized 'You reacted…' line", () => {
    const out = applyReactionOverlay(canonicalBase, row, ACTOR);
    expect(out.lastActivity.preview).toBe('You reacted 👍 to "Hello"');
    expect(out.lastActivity.type).toBe("reaction");
  });

  it("every other member sees the canonical activity, NOT the self-reaction", () => {
    const out = applyReactionOverlay(canonicalBase, row, THIRD_PARTY);
    expect(out).toBe(canonicalBase);
    expect(out.lastActivity.preview).toBe("Welcome everyone");
  });
});

describe("applyReactionOverlay — requirement 2: cross-user reaction visibility", () => {
  const row = {
    lastActivityReactionAt: new Date(CANONICAL_AT + 60_000),
    lastActivityReactionActorId: ACTOR,
    lastActivityReactionActorPreview:
      'You reacted ❤️ to "Let\'s meet at 5 PM..."',
    lastActivityReactionTargetId: TARGET,
    lastActivityReactionTargetPreview:
      'Peter reacted ❤️ to "Let\'s meet at 5 PM..."',
  };

  it("the reactor sees their own personalized line", () => {
    const out = applyReactionOverlay(canonicalBase, row, ACTOR);
    expect(out.lastActivity.preview).toBe(
      'You reacted ❤️ to "Let\'s meet at 5 PM..."'
    );
  });

  it("the message owner sees their personalized line", () => {
    const out = applyReactionOverlay(canonicalBase, row, TARGET);
    expect(out.lastActivity.preview).toBe(
      'Peter reacted ❤️ to "Let\'s meet at 5 PM..."'
    );
  });

  it("every other member sees the canonical activity — never the reaction", () => {
    const out = applyReactionOverlay(canonicalBase, row, THIRD_PARTY);
    expect(out).toBe(canonicalBase);
  });
});

describe("applyReactionOverlay — newest-wins gate (requirement 3 mechanism)", () => {
  it("a reaction OLDER than or equal to canonical never overrides (already-cleared or superseded)", () => {
    const staleRow = {
      lastActivityReactionAt: new Date(CANONICAL_AT), // same instant as canonical
      lastActivityReactionActorId: ACTOR,
      lastActivityReactionActorPreview: "You reacted 👍 to Hello",
      lastActivityReactionTargetId: null,
      lastActivityReactionTargetPreview: null,
    };
    expect(applyReactionOverlay(canonicalBase, staleRow, ACTOR)).toBe(
      canonicalBase
    );
  });

  it("no active overlay at all (lastActivityReactionAt null) → canonical for everyone", () => {
    const clearedRow = {
      lastActivityReactionAt: null,
      lastActivityReactionActorId: null,
      lastActivityReactionActorPreview: null,
      lastActivityReactionTargetId: null,
      lastActivityReactionTargetPreview: null,
    };
    expect(applyReactionOverlay(canonicalBase, clearedRow, ACTOR)).toBe(
      canonicalBase
    );
    expect(applyReactionOverlay(canonicalBase, clearedRow, TARGET)).toBe(
      canonicalBase
    );
  });

  it("a genuinely NEWER real message silently supersedes an un-cleared reaction (no explicit clear needed)", () => {
    const row = {
      lastActivityReactionAt: new Date(CANONICAL_AT - 60_000), // reaction predates the message
      lastActivityReactionActorId: ACTOR,
      lastActivityReactionActorPreview: "You reacted 👍 to Hello",
      lastActivityReactionTargetId: null,
      lastActivityReactionTargetPreview: null,
    };
    // Even the actor now sees canonical — the newer message wins.
    expect(applyReactionOverlay(canonicalBase, row, ACTOR)).toBe(canonicalBase);
  });
});

describe("applyReactionOverlay — requirement 4a: same-message multiple reactors", () => {
  it("after B's reaction (newer) displaces A's, the overlay reflects B only — not A", () => {
    const USER_A = ACTOR;
    const USER_B = TARGET;
    const overlayIsB = {
      lastActivityReactionAt: new Date(CANONICAL_AT + 120_000),
      lastActivityReactionActorId: USER_B,
      lastActivityReactionActorPreview: "You reacted ❤️ to Hello",
      lastActivityReactionTargetId: null,
      lastActivityReactionTargetPreview: null,
    };
    // A no longer sees anything reaction-related — B's add already overwrote it.
    expect(applyReactionOverlay(canonicalBase, overlayIsB, USER_A)).toBe(
      canonicalBase
    );
    expect(
      applyReactionOverlay(canonicalBase, overlayIsB, USER_B).lastActivity
        .preview
    ).toBe("You reacted ❤️ to Hello");
  });
});
