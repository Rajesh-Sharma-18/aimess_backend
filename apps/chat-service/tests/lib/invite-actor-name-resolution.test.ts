/**
 * An invitation row's chat-list sentence is rebuilt per reader from
 * `systemData` — so the SENDER's name has to survive on the row itself, and be
 * recoverable from the durable sender id when it does not.
 *
 * The reported symptom ("Someone shared a community invite") was NOT caused by
 * the two users un-friending: friendship is never consulted on this path. It
 * was an inviter whose profile has no first/last name — user-service builds
 * `displayName` from those two fields alone, so community-service published an
 * EMPTY `inviterName` and the row was stamped with an empty `actorName`. The
 * group twin escaped it only because chat-service's `resolveDisplayName` falls
 * back to the handle.
 *
 * These tests pin both halves: the read-time repair from `actorId`, and the
 * neutral fallback that must remain for a sender who cannot be named at all.
 */
import { buildPrivateSystemFallbackText } from "@aimess/constants";

import {
  resolveSystemActorName,
  withResolvedSystemActor,
} from "../../src/lib/localize-system-preview.js";
import { resolveRealDisplayName } from "../../src/services/user-snapshot.service.js";

const INVITER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RECIPIENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** What the writers persist when the inviter's name resolved to "". */
const namelessCommunityRow = {
  systemEvent: "COMMUNITY_INVITE",
  systemData: {
    invitationType: "COMMUNITY",
    communityId: "c1",
    linkCode: "abc123",
    inviterId: INVITER,
    inviterName: "",
    actorId: INVITER,
    actorName: "",
  },
};

const namelessGroupRow = {
  systemEvent: "GROUP_INVITE",
  systemData: {
    invitationType: "GROUP",
    groupId: "g1",
    token: "tok",
    inviterId: INVITER,
    inviterName: "",
    actorId: INVITER,
    actorName: "",
  },
};

const nameOf =
  (byId: Record<string, string>) =>
  (id: string): string =>
    byId[id] ?? "";

function sentence(
  row: { systemEvent: string; systemData: Record<string, unknown> },
  viewerUserId: string
): string {
  return buildPrivateSystemFallbackText(
    row.systemEvent,
    row.systemData,
    viewerUserId
  );
}

describe("resolveSystemActorName", () => {
  it("fills the missing actor name from the durable actorId", () => {
    const resolved = resolveSystemActorName(
      namelessCommunityRow.systemData,
      nameOf({ [INVITER]: "User B" })
    ) as Record<string, unknown>;
    expect(resolved.actorName).toBe("User B");
  });

  it("keeps a name the row already carries (never rewrites history)", () => {
    const data = { actorId: INVITER, actorName: "Stored Name" };
    expect(resolveSystemActorName(data, nameOf({ [INVITER]: "Renamed" }))).toBe(
      data
    );
  });

  it("recovers a legacy row that carries only inviterId", () => {
    const legacy = { inviterId: INVITER };
    const resolved = resolveSystemActorName(
      legacy,
      nameOf({ [INVITER]: "User B" })
    ) as Record<string, unknown>;
    expect(resolved.actorName).toBe("User B");
  });

  it("returns the input unchanged when there is no id or no name to use", () => {
    const noId = { actorName: "" };
    expect(resolveSystemActorName(noId, nameOf({}))).toBe(noId);
    expect(
      resolveSystemActorName(namelessCommunityRow.systemData, nameOf({}))
    ).toBe(namelessCommunityRow.systemData);
    expect(resolveSystemActorName(null, nameOf({}))).toBeNull();
  });

  it("does not touch a normal (non-system) row's absent systemData", () => {
    const row = { messageType: "TEXT", content: { text: "hi" } };
    expect(withResolvedSystemActor(row, nameOf({ [INVITER]: "User B" }))).toBe(
      row
    );
  });
});

describe("invitation lastActivity names the sender, friendship or not", () => {
  // The SAME resolved row is read by both parties and by every later refresh —
  // there is no per-viewer identity lookup to drift, so "both directions" and
  // "after reload" are the same assertion made twice.
  it.each([
    ["community", namelessCommunityRow, "User B shared a community invite"],
    ["group", namelessGroupRow, "User B shared a group invite"],
  ])(
    "%s invite: recipient sees the sender's name once the id is resolved",
    (_kind, row, expected) => {
      const repaired = withResolvedSystemActor(
        row,
        nameOf({ [INVITER]: "User B" })
      );
      expect(sentence(repaired, RECIPIENT)).toBe(expected);
    }
  );

  it.each([
    ["community", namelessCommunityRow, "You shared a community invite"],
    ["group", namelessGroupRow, "You shared a group invite"],
  ])("%s invite: the sender still reads it first-person", (_k, row, expected) => {
    const repaired = withResolvedSystemActor(
      row,
      nameOf({ [INVITER]: "User B" })
    );
    expect(sentence(repaired, INVITER)).toBe(expected);
  });

  it("falls back to 'Someone' only when the sender cannot be named at all", () => {
    // Nothing resolved the id — a deleted or vanished account. The row is left
    // alone rather than stamped with a placeholder.
    const untouched = withResolvedSystemActor(namelessCommunityRow, nameOf({}));
    expect(sentence(untouched, RECIPIENT)).toBe(
      "Someone shared a community invite"
    );
  });

  it("leaves a normal message preview untouched", () => {
    const text = { systemEvent: null, systemData: null };
    expect(withResolvedSystemActor(text, nameOf({ [INVITER]: "User B" }))).toBe(
      text
    );
  });
});

describe("resolveRealDisplayName", () => {
  it("uses the handle when the profile has no first/last name", () => {
    // Exactly the shape that produced the bug: user-service builds displayName
    // from firstName+lastName only, so it comes back empty.
    expect(
      resolveRealDisplayName({ displayName: "", username: "e2e_a4" })
    ).toBe("e2e_a4");
  });

  it("prefers a real display name over the handle", () => {
    expect(
      resolveRealDisplayName({ displayName: "User B", username: "userb" })
    ).toBe("User B");
  });

  it("returns empty for a deleted account, so no placeholder is baked in", () => {
    expect(
      resolveRealDisplayName({ displayName: "Deleted Account", isDeletedUser: true })
    ).toBe("");
    expect(resolveRealDisplayName(null)).toBe("");
    expect(resolveRealDisplayName({ displayName: "", username: "" })).toBe("");
  });
});
