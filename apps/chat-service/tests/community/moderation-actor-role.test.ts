/**
 * A community/group admin or moderator acting in that role is named by the
 * role ("Admin" / "Moderator"), never by their name; the actor still reads
 * "You", a Super Admin stays "Administrator", and a host ending their own
 * stream keeps their name.
 */
import {
  buildCommunitySystemFallbackText,
  buildGroupSystemFallbackText,
  communityCopy,
} from "@aimess/constants";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("community moderation lines name the actor by role", () => {
  const ban = (actorRole?: string, viewer = VIEWER, locale: "en" | "vi" | "th" = "en") =>
    buildCommunitySystemFallbackText(
      "MEMBER_BANNED",
      { actorUserId: ACTOR, targetUserId: TARGET, ...(actorRole ? { actorRole } : {}) },
      "Ana Admin",
      "Tom Target",
      viewer,
      locale
    );

  it("admin → 'Admin', moderator → 'Moderator', owner → 'Admin'", () => {
    expect(ban("ADMIN")).toBe("Admin banned Tom Target");
    expect(ban("MODERATOR")).toBe("Moderator banned Tom Target");
    expect(ban("OWNER")).toBe("Admin banned Tom Target");
  });

  it("localizes the role label", () => {
    expect(ban("MODERATOR", VIEWER, "vi")).toContain("Người kiểm duyệt");
    expect(ban("ADMIN", VIEWER, "th")).toContain("แอดมิน");
  });

  it("keeps the name on a legacy row with no role and 'You' for the actor", () => {
    expect(ban()).toBe("Ana Admin banned Tom Target");
    expect(ban("ADMIN", ACTOR)).not.toContain("Admin banned");
  });

  it("member added: 'Admin added Tom Target to Devs'", () => {
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_ADDED",
        {
          actorUserId: ACTOR,
          targetUserId: TARGET,
          actorRole: "MODERATOR",
          communityName: "Devs",
        },
        "Ana Admin",
        "Tom Target",
        VIEWER
      )
    ).toBe("Moderator added Tom Target to Devs");
  });

  it("livestream ended by an admin names the role and the host", () => {
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_ENDED",
        {
          actorUserId: ACTOR,
          targetUserId: TARGET,
          hostUserId: TARGET,
          endedReason: "USER",
          actorRole: "ADMIN",
        },
        "Ana Admin",
        "Jane Host",
        VIEWER
      )
    ).toMatch(/^Admin ended Jane Host's livestream/);
  });

  it("a host ending their own stream keeps their name", () => {
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_ENDED",
        { actorUserId: TARGET, hostUserId: TARGET, endedReason: "USER" },
        "Jane Host",
        "",
        VIEWER
      )
    ).toMatch(/^Jane Host ended the livestream/);
  });
});

describe("group moderation lines name the actor by role", () => {
  it("'Admin removed Tom from Team'", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", {
        actorId: ACTOR,
        actorName: "Ana Admin",
        actorRole: "ADMIN",
        targetUserId: TARGET,
        targetName: "Tom",
        groupName: "Team",
      })
    ).toBe("Admin removed Tom from Team");
  });
});

describe("push / inbox copy names the actor by role", () => {
  it("livestream ended", () => {
    const copy = communityCopy.livestreamEnded("Devs", "Ana Admin", "2m", "Jane Host", "ADMIN");
    expect(copy("en").body).toBe("Admin ended Jane Host's livestream in Devs after 2m");
  });

  it("member removed", () => {
    const copy = communityCopy.memberKicked("Devs", "Ana Admin", "Tom", ACTOR, TARGET, "MODERATOR");
    expect(copy("en", TARGET).body).toBe("Moderator removed You from Devs");
  });
});
