/**
 * The room decides the authorization gate — never the client's claim.
 *
 * Regression: a group send arriving with `conversationType: "private"` (the
 * Android text-send path defaulted it) was routed to the PRIVATE service and
 * rejected with "You must be friends to message this user". The mirror case is
 * the security half — claiming "GROUP" on a private room must not skip the
 * friendship gate.
 */
import { resolveConversationType } from "../../src/lib/conversation-type.js";

const GROUP = "grp_9ksRLM8soItjKho0";
const PRIVATE = "prv_abc123";

describe("resolveConversationType", () => {
  it("a grp_ room is GROUP even when the client claims private", () => {
    expect(resolveConversationType(GROUP, "private")).toBe("GROUP");
    expect(resolveConversationType(GROUP, "PRIVATE")).toBe("GROUP");
  });

  it("a prv_ room is PRIVATE even when the client claims GROUP", () => {
    expect(resolveConversationType(PRIVATE, "GROUP")).toBe("PRIVATE");
    expect(resolveConversationType(PRIVATE, "group")).toBe("PRIVATE");
  });

  it("the prefix wins with no claim at all", () => {
    expect(resolveConversationType(GROUP)).toBe("GROUP");
    expect(resolveConversationType(PRIVATE)).toBe("PRIVATE");
  });

  it("an unprefixed legacy id falls back to the claim, case-insensitively", () => {
    expect(resolveConversationType("legacy-room-1", "GROUP")).toBe("GROUP");
    expect(resolveConversationType("legacy-room-1", "group")).toBe("GROUP");
    expect(resolveConversationType("legacy-room-1", "private")).toBe("PRIVATE");
    expect(resolveConversationType("legacy-room-1")).toBe("PRIVATE");
  });

  it("null / undefined / empty ids never throw and default to PRIVATE", () => {
    expect(resolveConversationType(null)).toBe("PRIVATE");
    expect(resolveConversationType(undefined)).toBe("PRIVATE");
    expect(resolveConversationType("")).toBe("PRIVATE");
    expect(resolveConversationType("", null)).toBe("PRIVATE");
  });

  it("does not match a prefix appearing mid-id", () => {
    expect(resolveConversationType("cmt_grp_not_a_group")).toBe("PRIVATE");
  });
});
