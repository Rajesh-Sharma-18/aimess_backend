/**
 * Unit tests — group SYSTEM message fallback text (@aimess/constants).
 * Covers the Telegram-style ROLE_CHANGED promote/demote/ownership-transfer
 * distinction and the new MESSAGE_PINNED/MESSAGE_UNPINNED lines.
 */
import { buildGroupSystemFallbackText } from "@aimess/constants";

describe("buildGroupSystemFallbackText — ROLE_CHANGED", () => {
  it("POSITIVE: admin role change renders as resulting state", () => {
    const text = buildGroupSystemFallbackText("ROLE_CHANGED", {
      actorName: "Rajesh",
      targetName: "Peter Parker",
      oldRole: "MEMBER",
      newRole: "ADMIN",
    });
    expect(text).toBe("Peter Parker is now an admin");
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

  it("POSITIVE: owner role change renders as resulting state", () => {
    const text = buildGroupSystemFallbackText("ROLE_CHANGED", {
      actorName: "Rajesh",
      targetName: "Peter Parker",
      oldRole: "ADMIN",
      newRole: "OWNER",
    });
    expect(text).toBe("Peter Parker is now the group owner");
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
