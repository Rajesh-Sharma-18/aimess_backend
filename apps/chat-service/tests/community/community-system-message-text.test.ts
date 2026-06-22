import {
  buildCommunitySystemFallbackText,
  buildCommunitySystemSelfPreview,
  buildGroupSystemFallbackText,
  resolveCommunitySystemSubjectUserId,
} from "@aimess/constants";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BYSTANDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("system message text — display names and You personalization", () => {
  it("uses first+last name in third-person community lines (no username)", () => {
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_JOINED",
        { targetUserId: TARGET, actorUserId: TARGET },
        "Jim Methews",
        "Jim Methews"
      )
    ).toBe("Jim Methews joined the community");
  });

  it("shows You for the subject on role change", () => {
    expect(
      buildCommunitySystemFallbackText(
        "ROLE_CHANGED",
        {
          targetUserId: TARGET,
          actorUserId: ACTOR,
          newRole: "MODERATOR",
          oldRole: "MEMBER",
        },
        "Admin User",
        "Jim Methews",
        TARGET
      )
    ).toBe("You are now a moderator");
  });

  it("shows You for the actor on pin lines", () => {
    expect(
      buildCommunitySystemFallbackText(
        "PINNED_MESSAGE",
        { actorUserId: ACTOR },
        "Admin User",
        "",
        ACTOR
      )
    ).toBe("You pinned a message");
  });

  it("shows You for moderation targets", () => {
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_BANNED",
        { targetUserId: TARGET, actorUserId: ACTOR },
        "Admin User",
        "Jim Methews",
        TARGET
      )
    ).toBe("You were banned");
  });

  it("resolves subject user for moderation list bumps", () => {
    expect(
      resolveCommunitySystemSubjectUserId(
        "MEMBER_MUTED",
        { targetUserId: TARGET },
        ACTOR
      )
    ).toBe(TARGET);
  });

  it("builds self preview for banned subject", () => {
    expect(
      buildCommunitySystemSelfPreview(
        "MEMBER_BANNED",
        { targetUserId: TARGET, actorUserId: ACTOR },
        "Admin User",
        "Jim Methews",
        TARGET
      )
    ).toBe("You were banned");
  });

  it("personalizes group MEMBER_ADDED for the target", () => {
    expect(
      buildGroupSystemFallbackText(
        "MEMBER_ADDED",
        {
          actorId: ACTOR,
          targetUserId: TARGET,
          actorName: "Admin User",
          targetName: "Jim Methews",
        },
        TARGET
      )
    ).toBe("You were added to the group");
  });

  it("leaves bystander text third-person", () => {
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_LEFT",
        { targetUserId: TARGET, actorUserId: TARGET },
        "Jim Methews",
        "Jim Methews",
        BYSTANDER
      )
    ).toBe("Jim Methews left the community");
  });
});
