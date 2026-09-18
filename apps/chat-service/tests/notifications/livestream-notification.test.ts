/**
 * Livestream rows belong to LIVE_NOW by event TYPE — never by the community
 * the stream runs in — and every stream gets its own card per event.
 */
import {
  categorize,
  categorizeId,
  categoryWhere,
  isLiveType,
} from "../../src/lib/notification-category.js";
import {
  resolveGroupKey,
  resolveTransition,
} from "../../src/lib/notification-identity.js";

const LIVE = ["community.livestream_started", "community.livestream_ended"];
const COMMUNITY_ID = "c".repeat(24);

describe("livestream notification category", () => {
  it.each(LIVE)("%s is LIVE_NOW", (type) => {
    expect(isLiveType(type)).toBe(true);
    expect(categorizeId(type)).toBe("LIVE_NOW");
    // Legacy field unchanged — released clients still read COMMUNITIES.
    expect(categorize(type)).toBe("COMMUNITIES");
  });

  it.each([
    "community.member_added",
    "community.member_kicked",
    "community.member_role_changed",
    "community.join_request_approved",
    "community.join_request_rejected",
    "community.deleted",
  ])("ordinary community event %s stays COMMUNITY", (type) => {
    expect(isLiveType(type)).toBe(false);
    expect(categorizeId(type)).toBe("COMMUNITY");
  });

  it.each([
    ["friend.requested", "FRIEND_REQUEST"],
    ["chat.mention", "MENTION"],
    ["call.activity", "CALLS"],
    ["auth.security_new_login", "SYSTEM"],
    ["ANNOUNCEMENT", "SYSTEM"],
  ])("%s keeps its %s bucket", (type, id) => {
    expect(categorizeId(type)).toBe(id);
  });

  it("LIVE_NOW filter lists exactly the livestream types", () => {
    expect(categoryWhere("LIVE_NOW")).toEqual({ type: { in: LIVE } });
  });

  it("COMMUNITY filter excludes livestream rows, so none is counted twice", () => {
    const where = categoryWhere("COMMUNITY") as {
      AND: [unknown, { type: { notIn: string[] } }];
    };
    expect(where.AND[1].type.notIn).toEqual(expect.arrayContaining(LIVE));
    // Legacy token resolves to the same filter.
    expect(categoryWhere("COMMUNITIES")).toEqual(where);
  });
});

describe("livestream notification identity", () => {
  const data = (livestreamId: string) => ({
    communityId: COMMUNITY_ID,
    livestreamId,
  });

  it("keys a livestream row on the stream, not the community", () => {
    expect(
      resolveGroupKey("community.livestream_started", "host", data("s1"))
    ).toBe("livestream:s1:community.livestream_started");
  });

  it("gives two streams in one community two separate cards", () => {
    const a = resolveGroupKey("community.livestream_started", "h", data("s1"));
    const b = resolveGroupKey("community.livestream_started", "h", data("s2"));
    expect(a).not.toBe(b);
  });

  it("keeps started and ended of one stream as two cards", () => {
    expect(
      resolveGroupKey("community.livestream_started", "h", data("s1"))
    ).not.toBe(resolveGroupKey("community.livestream_ended", "h", data("s1")));
  });

  it("collapses a redelivered event onto its own card (no duplicate)", () => {
    const key = resolveGroupKey("community.livestream_ended", "h", data("s1"));
    expect(
      resolveGroupKey("community.livestream_ended", "h", data("s1"))
    ).toBe(key);
    expect(
      resolveTransition(
        "community.livestream_ended",
        "community.livestream_ended"
      ).action
    ).toBe("UPDATE");
  });

  it("leaves ordinary community keys unchanged", () => {
    expect(
      resolveGroupKey("community.member_kicked", "a", {
        communityId: COMMUNITY_ID,
        livestreamId: "s1",
      })
    ).toBe(`community:${COMMUNITY_ID}:membership`);
  });
});
