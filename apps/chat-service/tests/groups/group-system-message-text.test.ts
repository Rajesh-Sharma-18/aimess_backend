/**
 * Unit tests — group SYSTEM message fallback text (@aimess/constants).
 * Covers the Telegram-style ROLE_CHANGED promote/demote/ownership-transfer
 * distinction and the new MESSAGE_PINNED/MESSAGE_UNPINNED lines.
 */
import {
  buildGroupSystemFallbackText,
  personalizeGroupSystemMessageForViewer,
} from "@aimess/constants";

describe("buildGroupSystemFallbackText — ROLE_CHANGED", () => {
  // Admin promotion is a full hand-off — there is exactly ONE admin per
  // group, so it's phrased as "the group admin" (mirrors community's "the
  // community admin"), same as what used to be a separate "Transfer
  // Ownership" action.
  it("POSITIVE: admin hand-off renders as resulting state", () => {
    const text = buildGroupSystemFallbackText("ROLE_CHANGED", {
      actorName: "Rajesh",
      targetName: "Peter Parker",
      oldRole: "MEMBER",
      newRole: "ADMIN",
    });
    expect(text).toBe("Peter Parker is now the group admin");
  });

  it("POSITIVE: target viewer sees the self form of an admin hand-off", () => {
    const text = buildGroupSystemFallbackText(
      "ROLE_CHANGED",
      {
        actorName: "Rajesh",
        targetName: "Peter Parker",
        targetUserId: "target-1",
        oldRole: "MEMBER",
        newRole: "ADMIN",
      },
      "target-1"
    );
    expect(text).toBe("You are now the group admin");
  });

  it("POSITIVE: member role change renders as resulting state", () => {
    const text = buildGroupSystemFallbackText("ROLE_CHANGED", {
      actorName: "Rajesh",
      targetName: "Peter Parker",
      oldRole: "ADMIN",
      newRole: "MEMBER",
    });
    expect(text).toBe("Peter Parker is now a member");
  });

  it("POSITIVE: target viewer sees Community-style self copy", () => {
    const text = buildGroupSystemFallbackText(
      "ROLE_CHANGED",
      {
        actorName: "Rajesh",
        targetName: "Peter Parker",
        targetUserId: "target-1",
        newRole: "MODERATOR",
      },
      "target-1"
    );
    expect(text).toBe("You are now a moderator");
  });
});

describe("buildGroupSystemFallbackText — pin/unpin", () => {
  it("POSITIVE: MESSAGE_PINNED", () => {
    expect(
      buildGroupSystemFallbackText("MESSAGE_PINNED", { actorName: "Rajesh" })
    ).toBe("Rajesh pinned a message");
  });

  it("POSITIVE: MESSAGE_UNPINNED", () => {
    expect(
      buildGroupSystemFallbackText("MESSAGE_UNPINNED", { actorName: "Rajesh" })
    ).toBe("Rajesh unpinned a message");
  });
});

describe("buildGroupSystemFallbackText — MEMBER_BANNED / MEMBER_UNBANNED actor view", () => {
  const ROW = {
    actorId: "actor-1",
    actorName: "Smiley Creatures",
    targetUserId: "target-1",
    targetName: "Tom",
  };

  it("the admin who banned reads it first-person, not their own name", () => {
    expect(buildGroupSystemFallbackText("MEMBER_BANNED", ROW, "actor-1")).toBe(
      "You banned Tom"
    );
    expect(
      buildGroupSystemFallbackText("MEMBER_UNBANNED", ROW, "actor-1")
    ).toBe("You unbanned Tom");
  });

  it("other members and the stored row keep the actor's name", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_BANNED", ROW, "bystander-1")
    ).toBe("Smiley Creatures banned Tom");
    expect(buildGroupSystemFallbackText("MEMBER_UNBANNED", ROW)).toBe(
      "Smiley Creatures unbanned Tom"
    );
  });

  it("the target keeps the existing self copy", () => {
    expect(buildGroupSystemFallbackText("MEMBER_BANNED", ROW, "target-1")).toBe(
      "You were banned"
    );
    expect(
      buildGroupSystemFallbackText("MEMBER_UNBANNED", ROW, "target-1")
    ).toBe("You were unbanned");
  });

  it("localizes the actor view", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_BANNED", ROW, "actor-1", "vi")
    ).toBe("Bạn đã cấm Tom");
    expect(
      buildGroupSystemFallbackText("MEMBER_UNBANNED", ROW, "actor-1", "th")
    ).toBe("คุณปลดแบนTom");
  });
});

describe("buildGroupSystemFallbackText — MEMBER_REMOVED", () => {
  // The exact row the bug report screenshots: admin `actor-1` ("Smiley
  // Creatures") kicks `target-1` ("Tom"). One stored row, three readings.
  const REMOVAL = {
    actorId: "actor-1",
    actorName: "Smiley Creatures",
    targetUserId: "target-1",
    targetName: "Tom",
  };

  it("POSITIVE: the admin who removed the member reads it first-person", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", REMOVAL, "actor-1")
    ).toBe("You removed Tom from the group");
  });

  it("POSITIVE: another member still reads the actor's name", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", REMOVAL, "bystander-1")
    ).toBe("Smiley Creatures removed Tom from the group");
  });

  it("POSITIVE: the removed member keeps the existing self copy", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", REMOVAL, "target-1")
    ).toBe("Smiley Creatures removed You from the group");
  });

  it("POSITIVE: the stored (viewer-less) text stays third-person", () => {
    expect(buildGroupSystemFallbackText("MEMBER_REMOVED", REMOVAL)).toBe(
      "Smiley Creatures removed Tom from the group"
    );
  });

  // Backoffice removals post the row with `actorId: null`, so nobody is the
  // actor and the line must not collapse into a first-person sentence.
  it("POSITIVE: a platform-admin removal reads 'System' for everyone", () => {
    expect(
      buildGroupSystemFallbackText(
        "MEMBER_REMOVED",
        { actorId: null, targetUserId: "target-1", targetName: "Tom" },
        "bystander-1"
      )
    ).toBe("System removed Tom from the group");
  });

  it("POSITIVE: the actor line is localized, not English-only", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", REMOVAL, "actor-1", "vi")
    ).toBe("Bạn đã xóa Tom khỏi nhóm");
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", REMOVAL, "actor-1", "th")
    ).toBe("คุณนำTomออกจากกลุ่ม");
  });
});

describe("personalizeGroupSystemMessageForViewer — MEMBER_REMOVED", () => {
  // Realtime (socket fan-out) and history (REST serializer) both re-render the
  // stored row through this one function, so asserting it here is asserting
  // that the two surfaces cannot disagree.
  const STORED = "Smiley Creatures removed Tom from the group";
  const REMOVAL = {
    actorId: "actor-1",
    actorName: "Smiley Creatures",
    targetUserId: "target-1",
    targetName: "Tom",
  };

  it("POSITIVE: rebuilds the actor's perspective from the stored row", () => {
    expect(
      personalizeGroupSystemMessageForViewer(
        "MEMBER_REMOVED",
        REMOVAL,
        STORED,
        "actor-1"
      )
    ).toBe("You removed Tom from the group");
  });

  it("POSITIVE: leaves another member's row untouched", () => {
    expect(
      personalizeGroupSystemMessageForViewer(
        "MEMBER_REMOVED",
        REMOVAL,
        STORED,
        "bystander-1"
      )
    ).toBe(STORED);
  });
});

describe("buildGroupSystemFallbackText — named platform-admin removal", () => {
  // What a backoffice removal persists: the admin's NAME but no actorId, because
  // the acting admin is an AdminUser, not a chat user. Add/remove lines read
  // "System" for every reader (product rule); the name stays on the row for
  // audit and still names the admin on ban/unban.
  const PLATFORM = {
    actorId: null,
    actorName: "Super Admin",
    targetUserId: "target-1",
    targetName: "Tom",
  };

  it("POSITIVE: every remaining member reads 'System', not the admin's name", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", PLATFORM, "bystander-1")
    ).toBe("System removed Tom from the group");
    expect(buildGroupSystemFallbackText("MEMBER_REMOVED", PLATFORM)).toBe(
      "System removed Tom from the group"
    );
  });

  it("POSITIVE: the removed member keeps the self copy", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", PLATFORM, "target-1")
    ).toBe("System removed You from the group");
  });

  // The whole point of leaving actorId null: an AdminUser id is not a chat id,
  // so no viewer — including the admin, were they also a member — may ever read
  // this row first-person.
  it("NEGATIVE: nobody reads a platform removal as 'You removed …'", () => {
    for (const viewer of ["target-1", "bystander-1", "admin-user-1"]) {
      expect(
        buildGroupSystemFallbackText("MEMBER_REMOVED", PLATFORM, viewer)
      ).not.toContain("You removed");
    }
  });

  it("POSITIVE: the named line is localized like any other", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", PLATFORM, "bystander-1", "vi")
    ).toBe("Hệ thống đã xóa Tom khỏi nhóm");
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", PLATFORM, "bystander-1", "th")
    ).toBe("ระบบนำTomออกจากกลุ่ม");
  });

  // Ban/unban post through the same actor-less platform path, so the same gap
  // used to leave both reading "Someone".
  it("POSITIVE: ban and unban name the admin too", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_BANNED", PLATFORM, "bystander-1")
    ).toBe("Super Admin banned Tom");
    expect(
      buildGroupSystemFallbackText("MEMBER_UNBANNED", PLATFORM, "bystander-1")
    ).toBe("Super Admin unbanned Tom");
  });

  // Realtime and history both re-render the stored row through this one
  // function, so a named platform row cannot regress to "Someone" on reload.
  it("POSITIVE: the stored sentence survives per-viewer personalization", () => {
    const STORED = "System removed Tom from the group";
    expect(
      personalizeGroupSystemMessageForViewer(
        "MEMBER_REMOVED",
        PLATFORM,
        STORED,
        "bystander-1"
      )
    ).toBe(STORED);
  });
});

describe("buildGroupSystemFallbackText — historical actor resolution", () => {
  // The actor's name is baked into the row at write time, so a removal keeps
  // naming them after they leave the group, lose their role, or are removed
  // themselves — the renderer never consults the CURRENT member list.
  const HISTORIC = {
    actorId: "gone-1",
    actorName: "Viddhi Moneywala",
    targetUserId: "target-1",
    targetName: "Spider Man",
  };

  it("POSITIVE: an actor no longer in the group still resolves", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", HISTORIC, "bystander-1")
    ).toBe("Viddhi Moneywala removed Spider Man from the group");
  });

  it("POSITIVE: a target no longer in the group still resolves", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_ADDED", HISTORIC, "bystander-1")
    ).toBe("Viddhi Moneywala added Spider Man to the group");
  });
});
