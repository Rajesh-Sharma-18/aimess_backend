/**
 * v2: a community admin or moderator is named "Name (Role)" from the actorRole
 * snapshot; groups name people plainly; the actor still reads "You", and a host
 * ending their own stream keeps their name.
 */
import {
  buildCommunitySystemFallbackText,
  buildGroupSystemFallbackText,
  communityCopy,
} from "@aimess/constants";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("community moderation lines name the actor with role", () => {
  const ban = (actorRole?: string, viewer = VIEWER, locale: "en" | "vi" | "th" = "en") =>
    buildCommunitySystemFallbackText(
      "MEMBER_BANNED",
      { actorUserId: ACTOR, targetUserId: TARGET, ...(actorRole ? { actorRole } : {}) },
      "Ana Admin",
      "Tom Target",
      viewer,
      locale
    );

  it("admin → 'Name (Admin)', moderator → 'Name (Moderator)', owner → 'Name (Admin)'", () => {
    expect(ban("ADMIN")).toBe("Ana Admin (Admin) banned Tom Target");
    expect(ban("MODERATOR")).toBe("Ana Admin (Moderator) banned Tom Target");
    expect(ban("OWNER")).toBe("Ana Admin (Admin) banned Tom Target");
  });

  it("localizes the role label", () => {
    expect(ban("MODERATOR", VIEWER, "vi")).toContain("Người kiểm duyệt");
    expect(ban("ADMIN", VIEWER, "th")).toContain("แอดมิน");
  });

  it("keeps the name on a legacy row with no role and 'You' for the actor", () => {
    expect(ban()).toBe("Ana Admin banned Tom Target");
    expect(ban("ADMIN", ACTOR)).not.toContain("Admin banned");
  });

  it("member added names the person with role: 'Ana Admin (Moderator) added Tom Target'", () => {
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
    ).toBe("Ana Admin (Moderator) added Tom Target");
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
    ).toMatch(/^Ana Admin \(Admin\) ended Jane Host’s livestream/);
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

describe("group lines name people plainly", () => {
  it("'Ana Admin removed Tom'", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", {
        actorId: ACTOR,
        actorName: "Ana Admin",
        actorRole: "ADMIN",
        targetUserId: TARGET,
        targetName: "Tom",
        groupName: "Team",
      })
    ).toBe("Ana Admin removed Tom");
  });
});

describe("push / inbox copy names the actor with role", () => {
  it("livestream ended", () => {
    const copy = communityCopy.livestreamEnded("Devs", "Ana Admin", "2m", "Jane Host", "ADMIN");
    expect(copy("en").body).toBe("Ana Admin (Admin) ended Jane Host’s livestream in Devs after 2m");
  });

  it("member removed", () => {
    const copy = communityCopy.memberKicked("Devs", "Ana Admin", "Tom", ACTOR, TARGET, "MODERATOR");
    expect(copy("en", TARGET).body).toBe("Ana Admin (Moderator) removed you from Devs");
  });
});
