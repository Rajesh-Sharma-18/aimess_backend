/**
 * Suite: community-update-system-message
 *
 * Pins the Telegram-style "specific-or-collapsed" rule for the system message
 * posted by `communityService.update()`:
 *   - a SINGLE changed field → its dedicated specific subtype where one exists
 *     (name / description / avatar / banner / handle), else the generic
 *     COMMUNITY_UPDATED;
 *   - MULTIPLE simultaneous fields → exactly ONE collapsed COMMUNITY_UPDATED
 *     ("Community settings updated").
 *
 * Regression target: description/banner edits previously collapsed into the
 * generic "Community info was updated" line, and a multi-field save posted up to
 * three separate lines. Covers Issue #6.
 *
 * LIMITATION (documented, not a gap): a multi-field save still collapses to ONE
 * generic COMMUNITY_UPDATED line rather than one line per changed field — see
 * the "collapses multiple simultaneous changes" test below and the doc comment
 * on `selectCommunityUpdateSystemMessageType` in community.service.ts.
 *
 * Pure unit test of the exported selection helper — no repository / cache / gRPC
 * surface needed (the helper is the single source of truth the service calls).
 */

import {
  selectCommunityUpdateSystemMessageType,
  detectCommunityChangedFields,
  changedFieldsToMetaChanges,
} from "../../src/services/community.service.js";

describe("selectCommunityUpdateSystemMessageType", () => {
  it("returns null when nothing changed", () => {
    expect(selectCommunityUpdateSystemMessageType([])).toBeNull();
  });

  it("maps each single field to its dedicated subtype", () => {
    expect(selectCommunityUpdateSystemMessageType(["name"])).toBe(
      "COMMUNITY_NAME_UPDATED"
    );
    expect(selectCommunityUpdateSystemMessageType(["description"])).toBe(
      "COMMUNITY_DESCRIPTION_UPDATED"
    );
    expect(selectCommunityUpdateSystemMessageType(["avatar"])).toBe(
      "COMMUNITY_AVATAR_UPDATED"
    );
    expect(selectCommunityUpdateSystemMessageType(["banner"])).toBe(
      "COMMUNITY_BANNER_UPDATED"
    );
    expect(selectCommunityUpdateSystemMessageType(["handle"])).toBe(
      "COMMUNITY_HANDLE_UPDATED"
    );
  });

  it("uses the generic COMMUNITY_UPDATED for a single field with no dedicated subtype", () => {
    expect(selectCommunityUpdateSystemMessageType(["visibility"])).toBe(
      "COMMUNITY_UPDATED"
    );
    expect(selectCommunityUpdateSystemMessageType(["category"])).toBe(
      "COMMUNITY_UPDATED"
    );
  });

  it("collapses multiple simultaneous changes into ONE COMMUNITY_UPDATED line", () => {
    expect(selectCommunityUpdateSystemMessageType(["name", "avatar"])).toBe(
      "COMMUNITY_UPDATED"
    );
    expect(
      selectCommunityUpdateSystemMessageType(["name", "description", "avatar"])
    ).toBe("COMMUNITY_UPDATED");
    expect(
      selectCommunityUpdateSystemMessageType(["description", "handle"])
    ).toBe("COMMUNITY_UPDATED");
  });
});

/**
 * Change-DETECTION is the actual cause of the "always generic 'Community was
 * updated'" report: an edit form resubmits the WHOLE community (same avatar key,
 * same category, same description) even when only one field was touched, so a
 * naive "present in payload" check inflated changedFields to 2+ and collapsed
 * every save into the generic line. Only a genuine value diff may count.
 */
describe("detectCommunityChangedFields — only genuine value diffs count", () => {
  const CURRENT = {
    name: "old name",
    description: "old desc",
    avatarUrl: "community/avatar/u1/old.png",
    type: "PUBLIC",
    categoryId: "cat-1",
    handle: "old-handle",
  };

  // The whole point: a form that touches ONLY the name but resubmits the
  // existing avatar key, the same category, and the same description must yield
  // exactly ["name"] → the specific COMMUNITY_NAME_UPDATED line.
  it("returns only the genuinely changed field when the form resubmits everything unchanged", () => {
    const changed = detectCommunityChangedFields(CURRENT, {
      name: "new name",
      description: "old desc", // unchanged
      avatarProvided: true,
      nextAvatarUrl: "community/avatar/u1/old.png", // same key resubmitted
      type: "PUBLIC", // unchanged
      categoryId: "cat-1", // unchanged
      handle: "old-handle", // unchanged
    });

    expect(changed).toEqual(["name"]);
    expect(selectCommunityUpdateSystemMessageType(changed)).toBe(
      "COMMUNITY_NAME_UPDATED"
    );
  });

  it("does NOT count a resubmitted identical avatar key as a change", () => {
    const changed = detectCommunityChangedFields(CURRENT, {
      avatarProvided: true,
      nextAvatarUrl: "community/avatar/u1/old.png",
      description: undefined,
    });
    expect(changed).toEqual([]);
    expect(selectCommunityUpdateSystemMessageType(changed)).toBeNull();
  });

  it("counts a genuinely new avatar key", () => {
    const changed = detectCommunityChangedFields(CURRENT, {
      avatarProvided: true,
      nextAvatarUrl: "community/avatar/u1/new.png",
      description: undefined,
    });
    expect(changed).toEqual(["avatar"]);
    expect(selectCommunityUpdateSystemMessageType(changed)).toBe(
      "COMMUNITY_AVATAR_UPDATED"
    );
  });

  it("counts a genuinely new handle and maps it to the dedicated subtype", () => {
    const changed = detectCommunityChangedFields(CURRENT, {
      avatarProvided: false,
      nextAvatarUrl: null,
      description: undefined,
      handle: "new-handle",
    });
    expect(changed).toEqual(["handle"]);
    expect(selectCommunityUpdateSystemMessageType(changed)).toBe(
      "COMMUNITY_HANDLE_UPDATED"
    );
  });

  it("does NOT count a resubmitted identical handle as a change", () => {
    const changed = detectCommunityChangedFields(CURRENT, {
      avatarProvided: false,
      nextAvatarUrl: null,
      description: undefined,
      handle: "old-handle",
    });
    expect(changed).toEqual([]);
  });

  it("does NOT count a resubmitted identical category", () => {
    const changed = detectCommunityChangedFields(CURRENT, {
      avatarProvided: false,
      nextAvatarUrl: null,
      categoryId: "cat-1",
      description: undefined,
    });
    expect(changed).toEqual([]);
  });

  it("treats null↔'' description as no change but a real text edit as a change", () => {
    // null current, '' incoming → not a change
    expect(
      detectCommunityChangedFields(
        { ...CURRENT, description: null },
        { avatarProvided: false, nextAvatarUrl: null, description: "" }
      )
    ).toEqual([]);
    // real edit → change
    expect(
      detectCommunityChangedFields(CURRENT, {
        avatarProvided: false,
        nextAvatarUrl: null,
        description: "new desc",
      })
    ).toEqual(["description"]);
  });

  it("clearing an existing avatar (key → null) counts as an avatar change", () => {
    const changed = detectCommunityChangedFields(CURRENT, {
      avatarProvided: true,
      nextAvatarUrl: null,
      description: undefined,
    });
    expect(changed).toEqual(["avatar"]);
  });

  it("genuinely multi-field edits still collapse to the generic line", () => {
    const changed = detectCommunityChangedFields(CURRENT, {
      name: "new name",
      avatarProvided: true,
      nextAvatarUrl: "community/avatar/u1/new.png",
      description: undefined,
    });
    expect(changed.sort()).toEqual(["avatar", "name"]);
    expect(selectCommunityUpdateSystemMessageType(changed)).toBe(
      "COMMUNITY_UPDATED"
    );
  });
});

/**
 * The SAME changedFields array that picks the system-message subtype also drives
 * the `changes` boolean map on the `community:meta:updated` socket payload — so
 * the chat line and the metadata-sync event can never disagree about what changed.
 */
describe("changedFieldsToMetaChanges — maps changed fields to the socket `changes` map", () => {
  it("returns an empty object for no changes", () => {
    expect(changedFieldsToMetaChanges([])).toEqual({});
  });

  it("maps each known field to its boolean flag", () => {
    expect(changedFieldsToMetaChanges(["name"])).toEqual({ name: true });
    expect(changedFieldsToMetaChanges(["description"])).toEqual({
      description: true,
    });
    expect(changedFieldsToMetaChanges(["avatar"])).toEqual({ avatar: true });
    expect(changedFieldsToMetaChanges(["visibility"])).toEqual({
      visibility: true,
    });
    expect(changedFieldsToMetaChanges(["category"])).toEqual({
      category: true,
    });
    expect(changedFieldsToMetaChanges(["handle"])).toEqual({ handle: true });
  });

  it("sets a flag per field on a multi-field change", () => {
    expect(
      changedFieldsToMetaChanges(["name", "avatar", "description"])
    ).toEqual({ name: true, avatar: true, description: true });
  });

  it("ignores unknown field names", () => {
    expect(changedFieldsToMetaChanges(["bogus", "name"])).toEqual({
      name: true,
    });
  });
});
