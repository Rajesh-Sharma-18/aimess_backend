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

import { selectListPreview } from "../../src/services/community.service.js";

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

  it("works for the join line too (subject sees 'You joined the community')", () => {
    const row = {
      lastActivityType: "join",
      lastActivityPreview: "Jim joined the community",
      lastActivitySelfPreview: "You joined the community",
      lastActivityUserId: SUBJECT,
    };
    expect(selectListPreview(row, SUBJECT)).toBe("You joined the community");
    expect(selectListPreview(row, OTHER)).toBe("Jim joined the community");
  });

  it("backfills old join rows that do not have a stored self preview", () => {
    const row = {
      lastActivityType: "join",
      lastActivityPreview: "Jim joined the community",
      lastActivitySelfPreview: null,
      lastActivityUserId: SUBJECT,
    };
    expect(selectListPreview(row, SUBJECT)).toBe("You joined the community");
    expect(selectListPreview(row, OTHER)).toBe("Jim joined the community");
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
