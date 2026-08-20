/**
 * Suite: community-self-preview
 *
 * Pins the per-viewer personalization of the `GET /communities/mine` list
 * preview for self-referential SYSTEM lines (role change / join):
 *   - the viewer who IS the subject sees the first-person "You …" line;
 *   - every other member sees the third-person line;
 *   - non-self lines (a normal message, a community-wide system line with no
 *     stored selfPreview) are returned verbatim to everyone.
 *
 * Regression target: Jim demoted himself-or-was-demoted and the community list
 * showed "Jim Methews is now a member" to Jim instead of "You are now a member".
 *
 * Pure unit test of the exported `selectListPreview` helper — the single source
 * of truth `listMine` calls; no repository / cache surface needed.
 */

import { runWithLocale } from "@aimess/constants";

import {
  selectListPreview,
  applyPersonalLastActivityOverlay,
} from "../../src/services/community.service.js";

const SUBJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("selectListPreview", () => {
  it("gives the subject the first-person 'You …' preview", () => {
    const row = {
      lastActivityPreview: "Jim is now a moderator",
      lastActivitySelfPreview: "You are now a moderator",
      lastActivityUserId: SUBJECT,
    };
    expect(selectListPreview(row, SUBJECT)).toBe("You are now a moderator");
  });

  it("gives every other member the third-person preview", () => {
    const row = {
      lastActivityPreview: "Jim is now a moderator",
      lastActivitySelfPreview: "You are now a moderator",
      lastActivityUserId: SUBJECT,
    };
    expect(selectListPreview(row, OTHER)).toBe("Jim is now a moderator");
  });

  it("hides join activity from every member except the joiner", () => {
    const row = {
      lastActivityType: "join",
      lastActivityPreview: "Jim joined the community",
      lastActivitySelfPreview: "You joined the community",
      lastActivityUserId: SUBJECT,
    };
    expect(selectListPreview(row, SUBJECT)).toBe("You joined the community");
    expect(selectListPreview(row, OTHER)).toBeNull();
  });

  it("works for the join line too (subject sees 'You joined the community')", () => {
    const row = {
      lastActivityType: "join",
      lastActivityPreview: "Jim joined the community",
      lastActivitySelfPreview: "You joined the community",
      lastActivityUserId: SUBJECT,
    };
    expect(selectListPreview(row, SUBJECT)).toBe("You joined the community");
    expect(selectListPreview(row, OTHER)).toBeNull();
  });

  it("backfills old join rows that do not have a stored self preview", () => {
    const row = {
      lastActivityType: "join",
      lastActivityPreview: "Jim joined the community",
      lastActivitySelfPreview: null,
      lastActivityUserId: SUBJECT,
    };
    expect(selectListPreview(row, SUBJECT)).toBe("You joined the community");
    expect(selectListPreview(row, OTHER)).toBeNull();
  });

  it("returns the third-person preview when there is no selfPreview (community-wide line)", () => {
    const row = {
      lastActivityPreview: "Community photo updated",
      lastActivitySelfPreview: null,
      lastActivityUserId: SUBJECT,
    };
    // Even the matching viewer gets the shared line — nothing to personalize.
    expect(selectListPreview(row, SUBJECT)).toBe("Community photo updated");
  });

  it("allows an empty selfPreview to clear a deleted-for-me viewer preview", () => {
    const row = {
      lastActivityPreview: "deleted message text",
      lastActivitySelfPreview: "",
      lastActivityUserId: SUBJECT,
    };
    expect(selectListPreview(row, SUBJECT)).toBe("");
    expect(selectListPreview(row, OTHER)).toBe("deleted message text");
  });

  it("does NOT leak the self preview when the subject id does not match the viewer", () => {
    const row = {
      lastActivityPreview: "Jim is now a moderator",
      lastActivitySelfPreview: "You are now a moderator",
      lastActivityUserId: SUBJECT,
    };
    // A stale/blank viewer id must never see another member's "You …" line.
    expect(selectListPreview(row, "")).toBe("Jim is now a moderator");
  });

  it("returns null when there is no stored preview at all", () => {
    expect(
      selectListPreview(
        {
          lastActivityPreview: null,
          lastActivitySelfPreview: null,
          lastActivityUserId: null,
        },
        SUBJECT
      )
    ).toBeNull();
  });
});

/**
 * `lastActivityTargetUserId`/`lastActivityTargetPreview` used to carry
 * reaction personalization; reactions now use a fully separate mechanism
 * (`applyReactionOverlay` + the `lastActivityReaction*` columns — see
 * community-reaction-activity.test.ts) so a reaction is never visible to
 * anyone but its own actor/target, not even via a third-person fallback
 * line. These tests keep pinning the generic target-preview mechanism
 * itself (reserved for a future second self-referential viewer, e.g. a
 * two-sided lifecycle line) using reaction-shaped fixtures only because
 * that was the original motivating case — not because reactions still flow
 * through here.
 */
describe("selectListPreview — generic target-preview mechanism (reaction-shaped fixtures)", () => {
  const ACTOR = SUBJECT;
  const TARGET = OTHER;
  const THIRD_PARTY = "33333333-3333-4333-8333-333333333333";

  const reactionRow = {
    lastActivityType: "reaction",
    lastActivityPreview: "Jim reacted ❤️ to Jane's message",
    lastActivitySelfPreview: "You reacted ❤️ to Jane's message",
    lastActivityUserId: ACTOR,
    lastActivityTargetUserId: TARGET,
    lastActivityTargetPreview: "Jim reacted ❤️ to your message",
  };

  it("gives the actor the first-person 'You reacted …' preview", () => {
    expect(selectListPreview(reactionRow, ACTOR)).toBe(
      "You reacted ❤️ to Jane's message"
    );
  });

  it("gives the target (message owner) the '…to your message' preview", () => {
    expect(selectListPreview(reactionRow, TARGET)).toBe(
      "Jim reacted ❤️ to your message"
    );
  });

  it("gives every other member the third-person preview", () => {
    expect(selectListPreview(reactionRow, THIRD_PARTY)).toBe(
      "Jim reacted ❤️ to Jane's message"
    );
  });

  it("self-reaction collapses target into self (actor === target)", () => {
    const selfReactionRow = {
      lastActivityType: "reaction",
      lastActivityPreview: "Jim reacted ❤️ to their own message",
      lastActivitySelfPreview: "You reacted ❤️ to your message",
      lastActivityUserId: ACTOR,
      // No separate target row written when actor === target (see
      // service-impl.ts / community-message.controller.ts reaction handlers).
      lastActivityTargetUserId: null,
      lastActivityTargetPreview: null,
    };
    expect(selectListPreview(selfReactionRow, ACTOR)).toBe(
      "You reacted ❤️ to your message"
    );
    expect(selectListPreview(selfReactionRow, THIRD_PARTY)).toBe(
      "Jim reacted ❤️ to their own message"
    );
  });

  it("target-preview branch is a no-op for non-reaction rows (target fields absent)", () => {
    const messageRow = {
      lastActivityType: "message",
      lastActivityPreview: "Hello!",
      lastActivitySelfPreview: null,
      lastActivityUserId: ACTOR,
    };
    expect(selectListPreview(messageRow, TARGET)).toBe("Hello!");
  });
});

/**
 * Suite: applyPersonalLastActivityOverlay
 *
 * Pins the per-viewer PERSONAL overlay that gives the joiner "You joined the
 * community" as their /communities/mine lastActivity while everyone else keeps
 * the community-wide message — the single source of truth `listMine` calls.
 *
 * Scenario (from the spec):
 *   10:00  Community photo updated   (community-wide)
 *   10:05  You joined the community  (PERSONAL → joiner only)
 *   joiner → "You joined the community" (@10:05);  others → "Community photo updated" (@10:00)
 */
describe("applyPersonalLastActivityOverlay", () => {
  const PHOTO_AT = 1_700_000_000_000; // 10:00 community-wide
  const JOIN_AT = PHOTO_AT + 5 * 60_000; // 10:05 personal

  const communityWide = {
    lastActivity: {
      type: "system" as const,
      userId: null,
      username: null,
      preview: "Community photo updated",
      dateTime: PHOTO_AT,
    },
    lastActivityAt: PHOTO_AT,
  };

  it("overlays the joiner's 'You joined the community' line when it is newer (Test 3 — joiner)", () => {
    const out = applyPersonalLastActivityOverlay(communityWide, {
      message: "You joined the community",
      dateTime: JOIN_AT,
    });
    expect(out.lastActivity.preview).toBe("You joined the community");
    expect(out.lastActivity.type).toBe("system");
    expect(out.lastActivity.username).toBeNull();
    expect(out.lastActivityAt).toBe(JOIN_AT);
  });

  it("leaves the community-wide activity untouched for other members (Test 3 — admin/mod/member)", () => {
    // Admin / moderator / member receive NO personal line → base is returned.
    const out = applyPersonalLastActivityOverlay(communityWide, undefined);
    expect(out).toBe(communityWide);
    expect(out.lastActivity.preview).toBe("Community photo updated");
    expect(out.lastActivityAt).toBe(PHOTO_AT);
  });

  it("does NOT overlay a personal line that is older than the community-wide activity", () => {
    const out = applyPersonalLastActivityOverlay(communityWide, {
      message: "You joined the community",
      dateTime: PHOTO_AT - 1,
    });
    expect(out.lastActivity.preview).toBe("Community photo updated");
    expect(out.lastActivityAt).toBe(PHOTO_AT);
  });

  it("ignores an empty personal message", () => {
    const out = applyPersonalLastActivityOverlay(communityWide, {
      message: "",
      dateTime: JOIN_AT,
    });
    expect(out).toBe(communityWide);
  });
});

/**
 * The row and the transcript preview the SAME system line, so they must agree on
 * language. Only the stored English rendering is swapped — a personal overlay
 * (delete-for-me writes another message's text into `selfPreview`) and a legacy
 * row with no stored event are returned exactly as stored.
 */
describe("selectListPreview — reader language", () => {
  const roleChange = {
    lastActivityType: "system",
    lastActivityPreview: "Alex is now a moderator",
    lastActivitySystemType: "ROLE_CHANGED",
    lastActivitySystemMetadata: {
      targetUserId: "u-alex",
      targetName: "Alex",
      newRole: "MODERATOR",
    },
  };

  it("renders the row in the reader's language", () => {
    const en = selectListPreview(roleChange, "u-other");
    expect(en).toBe("Alex is now a moderator");

    const vi = runWithLocale("vi", () =>
      selectListPreview(roleChange, "u-other")
    );
    expect(vi).not.toBe(en);
    expect(vi).toContain("Alex");

    const th = runWithLocale("th", () =>
      selectListPreview(roleChange, "u-other")
    );
    expect(th).not.toBe(en);
    expect(th).not.toBe(vi);
  });

  it("keeps a legacy row (no stored event) exactly as written", () => {
    const legacy = {
      lastActivityType: "system",
      lastActivityPreview: "Alex is now a moderator",
    };
    expect(
      runWithLocale("vi", () => selectListPreview(legacy, "u-other"))
    ).toBe("Alex is now a moderator");
  });

  it("never rewrites a personal overlay that is not this row's system line", () => {
    const hidden = {
      ...roleChange,
      lastActivityUserId: "u-me",
      // delete-for-me overlay: the viewer's own previous-visible message.
      lastActivitySelfPreview: "See you tomorrow",
    };
    expect(runWithLocale("vi", () => selectListPreview(hidden, "u-me"))).toBe(
      "See you tomorrow"
    );
  });
});
