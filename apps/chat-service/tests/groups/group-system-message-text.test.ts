/**
 * Unit tests — group SYSTEM message fallback text (@aimess/constants).
 * Covers the Telegram-style ROLE_CHANGED promote/demote/ownership-transfer
 * distinction and the new MESSAGE_PINNED/MESSAGE_UNPINNED lines.
 */
import { buildGroupSystemFallbackText } from "@aimess/constants";

describe("buildGroupSystemFallbackText — ROLE_CHANGED", () => {
  it("POSITIVE: promotion (MEMBER -> ADMIN) reads as a promotion, not a generic role change", () => {
    const text = buildGroupSystemFallbackText("ROLE_CHANGED", {
      actorName: "Rajesh",
      targetName: "Peter Parker",
      oldRole: "MEMBER",
      newRole: "ADMIN",
    });
    expect(text).toBe("Rajesh promoted Peter Parker to Admin");
  });

  it("POSITIVE: demotion (ADMIN -> MEMBER) reads as a demotion", () => {
    const text = buildGroupSystemFallbackText("ROLE_CHANGED", {
      actorName: "Rajesh",
      targetName: "Peter Parker",
      oldRole: "ADMIN",
      newRole: "MEMBER",
    });
    expect(text).toBe("Rajesh demoted Peter Parker to Member");
  });

  it("POSITIVE: transfer to OWNER reads as an ownership transfer regardless of oldRole", () => {
    const text = buildGroupSystemFallbackText("ROLE_CHANGED", {
      actorName: "Rajesh",
      targetName: "Peter Parker",
      oldRole: "ADMIN",
      newRole: "OWNER",
    });
    expect(text).toBe("Rajesh made Peter Parker the group owner");
  });

  it("EDGE: falls back to the generic form when oldRole is unknown", () => {
    const text = buildGroupSystemFallbackText("ROLE_CHANGED", {
      actorName: "Rajesh",
      targetName: "Peter Parker",
      newRole: "MODERATOR",
    });
    expect(text).toBe("Rajesh changed Peter Parker's role to MODERATOR");
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
