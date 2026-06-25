import {
  buildCommunitySystemFallbackText,
  buildCommunitySystemSelfPreview,
  buildGroupSystemFallbackText,
  resolveCommunitySystemSubjectUserId,
  sanitizeCommunitySystemMetadata,
  isActorLessSystemMessage,
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

  it("displays community created message", () => {
    expect(
      buildCommunitySystemFallbackText(
        "COMMUNITY_CREATED",
        { actorUserId: ACTOR },
        "Admin User",
        ""
      )
    ).toBe("Community created");
  });

  it("displays renamed message with new community name", () => {
    // Publisher passes metadata.newName — must match the key the builder reads.
    expect(
      buildCommunitySystemFallbackText(
        "COMMUNITY_NAME_UPDATED",
        { newName: "New Community Name" },
        "",
        ""
      )
    ).toBe('Community renamed to "New Community Name"');
  });

  it("displays community name updated fallback when name is missing", () => {
    expect(
      buildCommunitySystemFallbackText("COMMUNITY_NAME_UPDATED", {}, "", "")
    ).toBe("Community name updated");
  });

  it("displays live stream started message", () => {
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_STARTED",
        { actorUserId: ACTOR },
        "Admin User",
        ""
      )
    ).toBe("Live stream started");
  });

  it("displays live stream ended message with duration", () => {
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_ENDED",
        { duration: "2 hours 15 minutes" },
        "",
        ""
      )
    ).toBe("Live stream ended (2 hours 15 minutes)");
  });

  it("displays live stream ended message without duration", () => {
    expect(
      buildCommunitySystemFallbackText("LIVE_STREAM_ENDED", {}, "", "")
    ).toBe("Live stream ended");
  });
});

/**
 * ACTOR-LESS metadata sanitization: the real fix for the "Jim Methews created the
 * community" bug. The client localizes SYSTEM lines from systemMessageType +
 * systemMetadata; if actorName/creatorName leak for a pure-event type, the client
 * renders "{name} created the community". sanitizeCommunitySystemMetadata strips
 * actor/target identity for actor-less types (persist, socket, AND read paths) so
 * no name can ever reach the client — including on legacy rows that stored the
 * old creatorId/creatorName schema.
 */
describe("sanitizeCommunitySystemMetadata — actor identity is stripped", () => {
  it("COMMUNITY_CREATED: strips current-schema actorUserId/actorName", () => {
    expect(
      sanitizeCommunitySystemMetadata("COMMUNITY_CREATED", {
        communityName: "Tech",
        actorUserId: ACTOR,
        actorName: "Jim Methews",
      })
    ).toEqual({ communityName: "Tech" });
  });

  it("COMMUNITY_CREATED: strips legacy-schema creatorId/creatorName", () => {
    expect(
      sanitizeCommunitySystemMetadata("COMMUNITY_CREATED", {
        communityName: "Tech",
        creatorId: ACTOR,
        creatorName: "Himanshu Vasu",
      })
    ).toEqual({ communityName: "Tech" });
  });

  it("keeps event-only fields for other actor-less types", () => {
    expect(
      sanitizeCommunitySystemMetadata("COMMUNITY_NAME_UPDATED", {
        newName: "New Name",
        actorName: "Jim Methews",
      })
    ).toEqual({ newName: "New Name" });
  });

  it("is a NO-OP for actor-bearing types (role change keeps target/actor)", () => {
    const md = {
      targetUserId: TARGET,
      targetName: "Target User",
      actorUserId: ACTOR,
      actorName: "Admin",
      oldRole: "MEMBER",
      newRole: "MODERATOR",
    };
    expect(sanitizeCommunitySystemMetadata("ROLE_CHANGED", md)).toEqual(md);
  });

  it("classifies the actor-less lifecycle set correctly", () => {
    expect(isActorLessSystemMessage("COMMUNITY_CREATED")).toBe(true);
    expect(isActorLessSystemMessage("COMMUNITY_AVATAR_UPDATED")).toBe(true);
    expect(isActorLessSystemMessage("ROLE_CHANGED")).toBe(false);
    expect(isActorLessSystemMessage("MEMBER_BANNED")).toBe(false);
    expect(isActorLessSystemMessage(null)).toBe(false);
  });
});

/**
 * SSoT contract: the canonical builder MUST produce the same text regardless of
 * what was stored in GeneralRoomMessage.message.  personalizeSystemText() calls
 * buildCommunitySystemFallbackText() directly so stale stored rows are
 * transparently upgraded on read without a DB migration.
 */
describe("canonical builder — stale-row upgrade guarantee", () => {
  it("COMMUNITY_CREATED always returns canonical text, ignoring actor name", () => {
    // Old stored text: "Jim Methews created the community"
    // The builder must always return the canonical form so chat room == mine API.
    expect(
      buildCommunitySystemFallbackText(
        "COMMUNITY_CREATED",
        { actorUserId: ACTOR, actorName: "Jim Methews" },
        "Jim Methews",
        "",
        BYSTANDER // bystander viewer — must never see actor name in this type
      )
    ).toBe("Community created");
  });

  it("COMMUNITY_CREATED is canonical even for the creator", () => {
    expect(
      buildCommunitySystemFallbackText(
        "COMMUNITY_CREATED",
        { actorUserId: ACTOR, actorName: "Jim Methews" },
        "Jim Methews",
        "",
        ACTOR // creator viewing their own community
      )
    ).toBe("Community created");
  });

  it("COMMUNITY_AVATAR_UPDATED returns canonical text for any viewer", () => {
    expect(
      buildCommunitySystemFallbackText(
        "COMMUNITY_AVATAR_UPDATED",
        { actorUserId: ACTOR, actorName: "Jim Methews" },
        "Jim Methews",
        "",
        BYSTANDER
      )
    ).toBe("Community photo updated");
  });

  it("ROLE_CHANGED returns correct third-person text for a bystander", () => {
    const text = buildCommunitySystemFallbackText(
      "ROLE_CHANGED",
      {
        actorUserId: ACTOR,
        actorName: "Admin",
        targetUserId: TARGET,
        targetName: "John Doe",
        newRole: "MODERATOR",
        oldRole: "MEMBER",
      },
      "Admin",
      "John Doe",
      BYSTANDER
    );
    expect(text).toBe("John Doe is now a moderator");
  });

  it("ROLE_CHANGED returns You-form for the target", () => {
    const text = buildCommunitySystemFallbackText(
      "ROLE_CHANGED",
      {
        actorUserId: ACTOR,
        actorName: "Admin",
        targetUserId: TARGET,
        targetName: "John Doe",
        newRole: "MODERATOR",
        oldRole: "MEMBER",
      },
      "Admin",
      "John Doe",
      TARGET // the person whose role changed
    );
    expect(text).toBe("You are now a moderator");
  });
});

/**
 * Admin ownership hand-off phrasing (Issue #1). A community has exactly ONE admin,
 * so promotion to ADMIN reads "the community admin" rather than "an admin".
 */
describe("ROLE_CHANGED — ADMIN ownership hand-off phrasing", () => {
  it("third-person: 'X is now the community admin'", () => {
    expect(
      buildCommunitySystemFallbackText(
        "ROLE_CHANGED",
        {
          actorUserId: ACTOR,
          targetUserId: TARGET,
          targetName: "John Doe",
          newRole: "ADMIN",
          oldRole: "MODERATOR",
        },
        "Admin",
        "John Doe",
        BYSTANDER
      )
    ).toBe("John Doe is now the community admin");
  });

  it("self-form for the new admin: 'You are now the community admin'", () => {
    expect(
      buildCommunitySystemFallbackText(
        "ROLE_CHANGED",
        {
          actorUserId: ACTOR,
          targetUserId: TARGET,
          targetName: "John Doe",
          newRole: "ADMIN",
          oldRole: "MODERATOR",
        },
        "Admin",
        "John Doe",
        TARGET
      )
    ).toBe("You are now the community admin");
  });

  it("ROLE_CHANGED_SELF renders the admin self line directly", () => {
    expect(
      buildCommunitySystemFallbackText(
        "ROLE_CHANGED_SELF",
        { newRole: "ADMIN", oldRole: "MODERATOR" },
        "",
        "",
        TARGET
      )
    ).toBe("You are now the community admin");
  });

  it("outgoing admin demotion self line: 'You are now a member'", () => {
    expect(
      buildCommunitySystemFallbackText(
        "ROLE_CHANGED_SELF",
        { newRole: "MEMBER", oldRole: "ADMIN" },
        "",
        "",
        ACTOR
      )
    ).toBe("You are now a member");
  });
});

/**
 * HISTORICAL IMMUTABILITY (Issue #2). The read-time text builder is a PURE function
 * of the message's OWN stored metadata (its snapshot `newRole`/`oldRole`), never of
 * the member's CURRENT role. Therefore a "moderator" line written at promotion time
 * can NEVER mutate into an "admin" line when that same user is later promoted to
 * admin — the later promotion is a SEPARATE message with its OWN metadata. These
 * tests lock that contract: the same (type, metadata) always yields the same text,
 * and a later event with different metadata does not touch the earlier text.
 */
describe("historical immutability — text depends only on the message's own snapshot", () => {
  // The exact metadata persisted when User A was promoted Member → Moderator.
  const moderatorLineMetadata = {
    actorUserId: ACTOR,
    actorName: "Admin",
    targetUserId: TARGET,
    targetName: "Rajesh",
    newRole: "MODERATOR",
    oldRole: "MEMBER",
  };

  // A DISTINCT message persisted later when the SAME user was promoted to ADMIN.
  const adminLineMetadata = {
    actorUserId: ACTOR,
    actorName: "Admin",
    targetUserId: TARGET,
    targetName: "Rajesh",
    newRole: "ADMIN",
    oldRole: "MODERATOR",
  };

  const renderFor = (md: Record<string, unknown>, viewer: string) =>
    buildCommunitySystemFallbackText(
      "ROLE_CHANGED",
      md,
      String(md.actorName ?? ""),
      String(md.targetName ?? ""),
      viewer
    );

  it("the moderator line stays 'Rajesh is now a moderator' for bystanders, before AND after an admin promotion exists", () => {
    // Render the moderator line. Then render the (later) admin line. Then render
    // the moderator line AGAIN — its text is byte-identical because it reads only
    // its own frozen metadata. A future role change cannot reach back into it.
    const before = renderFor(moderatorLineMetadata, BYSTANDER);
    renderFor(adminLineMetadata, BYSTANDER); // later promotion happens
    const after = renderFor(moderatorLineMetadata, BYSTANDER);

    expect(before).toBe("Rajesh is now a moderator");
    expect(after).toBe(before);
  });

  it("the moderator line stays 'You are now a moderator' for the subject, independent of the admin line", () => {
    const moderatorSelf = renderFor(moderatorLineMetadata, TARGET);
    const adminSelf = renderFor(adminLineMetadata, TARGET);

    // Two independent, immutable lines — the moderator one is NOT rewritten to the
    // admin one.
    expect(moderatorSelf).toBe("You are now a moderator");
    expect(adminSelf).toBe("You are now the community admin");
    expect(moderatorSelf).not.toBe(adminSelf);
  });

  it("Member → Moderator → Admin yields three independent, stable lines", () => {
    const promotedToMod = renderFor(moderatorLineMetadata, BYSTANDER);
    const promotedToAdmin = renderFor(adminLineMetadata, BYSTANDER);
    const demotedToMember = renderFor(
      {
        ...moderatorLineMetadata,
        newRole: "MEMBER",
        oldRole: "ADMIN",
      },
      BYSTANDER
    );

    expect(promotedToMod).toBe("Rajesh is now a moderator");
    expect(promotedToAdmin).toBe("Rajesh is now the community admin");
    expect(demotedToMember).toBe("Rajesh is now a member");
    // Re-render the first line one more time: still the moderator text.
    expect(renderFor(moderatorLineMetadata, BYSTANDER)).toBe(promotedToMod);
  });
});
