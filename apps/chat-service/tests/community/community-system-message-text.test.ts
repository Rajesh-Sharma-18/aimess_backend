import {
  buildCommunitySystemFallbackText,
  buildCommunitySystemSelfPreview,
  buildGroupSystemFallbackText,
  resolveCommunitySystemSubjectUserId,
  sanitizeCommunitySystemMetadata,
  isActorLessSystemMessage,
  formatMuteDuration,
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

  // The actor is the USER who pinned — never the community. `communityName` is
  // still carried in metadata for community context and must NOT leak into the
  // actor slot (regression guard for "Developers Community pinned a message").
  it("names the pinning USER, not the community, for bystanders", () => {
    expect(
      buildCommunitySystemFallbackText(
        "PINNED_MESSAGE",
        { actorUserId: ACTOR, communityName: "Developers Community" },
        "John Smith",
        "",
        TARGET
      )
    ).toBe("John Smith pinned a message");
  });

  it("shows You for the pinner even when communityName is present", () => {
    expect(
      buildCommunitySystemFallbackText(
        "PINNED_MESSAGE",
        { actorUserId: ACTOR, communityName: "Developers Community" },
        "John Smith",
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
    ).toBe("You were banned from this community.");
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
    ).toBe("You were banned from this community.");
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
    ).toBe("Admin User added You to the group");
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

  it("displays live stream started message (host-named)", () => {
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_STARTED",
        { actorUserId: ACTOR },
        "Admin User",
        ""
      )
    ).toBe("Admin User started a livestream");
  });

  it('shows "You started a livestream" to the host', () => {
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_STARTED",
        { actorUserId: ACTOR },
        "Admin User",
        "",
        ACTOR
      )
    ).toBe("You started a livestream");
  });

  it("displays live stream ended message with duration (host-named)", () => {
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_ENDED",
        { actorUserId: ACTOR, duration: "1h 24m" },
        "Admin User",
        ""
      )
    ).toBe("Admin User ended the livestream (1h 24m)");
  });

  it('shows "You ended the livestream" to the host', () => {
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_ENDED",
        { actorUserId: ACTOR, duration: "1h 24m" },
        "Admin User",
        "",
        ACTOR
      )
    ).toBe("You ended the livestream (1h 24m)");
  });

  it("displays live stream ended message without duration", () => {
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_ENDED",
        { actorUserId: ACTOR },
        "Admin User",
        ""
      )
    ).toBe("Admin User ended the livestream");
  });

  it('platform end (endedReason SYSTEM) reads "System ended…" — never the host', () => {
    const meta = {
      actorUserId: ACTOR,
      duration: "36m",
      durationSeconds: 2160,
      endedReason: "SYSTEM",
    };
    expect(
      buildCommunitySystemFallbackText("LIVE_STREAM_ENDED", meta, "Admin User", "")
    ).toBe("System ended the livestream (36m)");
    // The host's own view is not "You ended…" either — they didn't end it.
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_ENDED",
        meta,
        "Admin User",
        "",
        ACTOR
      )
    ).toBe("System ended the livestream (36m)");
  });

  it('Super Admin end (endedReason ADMIN) reads "An administrator ended…" for everyone, host included', () => {
    const meta = {
      actorUserId: ACTOR,
      duration: "4m",
      durationSeconds: 240,
      endedReason: "ADMIN",
    };
    for (const viewer of [undefined, ACTOR, "viewer"]) {
      const text = buildCommunitySystemFallbackText(
        "LIVE_STREAM_ENDED",
        meta,
        "Host Name",
        "",
        viewer
      );
      expect(text).toBe("An administrator ended the livestream (4m)");
    }
    const vi = buildCommunitySystemFallbackText(
      "LIVE_STREAM_ENDED",
      meta,
      "Host Name",
      "",
      "viewer",
      "vi"
    );
    expect(vi.startsWith("Quản trị viên đã kết thúc buổi phát trực tiếp (")).toBe(true);
    expect(vi).not.toContain("Host Name");
  });

  it("community admin end names the admin (the actor), and the host reads the admin's name", () => {
    const meta = { actorUserId: "admin-id", duration: "4m", durationSeconds: 240, endedReason: "USER" };
    expect(
      buildCommunitySystemFallbackText("LIVE_STREAM_ENDED", meta, "Rajesh Sharma", "", ACTOR)
    ).toBe("Rajesh Sharma ended the livestream (4m)");
  });

  it("host end with endedReason USER keeps the host name", () => {
    expect(
      buildCommunitySystemFallbackText(
        "LIVE_STREAM_ENDED",
        { actorUserId: ACTOR, duration: "36m", durationSeconds: 2160, endedReason: "USER" },
        "Admin User",
        ""
      )
    ).toBe("Admin User ended the livestream (36m)");
  });

  it("platform end renders in the reader's locale, duration included", () => {
    const meta = {
      actorUserId: ACTOR,
      duration: "36m",
      durationSeconds: 2160,
      endedReason: "SYSTEM",
    };
    const vi = buildCommunitySystemFallbackText(
      "LIVE_STREAM_ENDED",
      meta,
      "Admin User",
      "",
      "viewer",
      "vi"
    );
    const th = buildCommunitySystemFallbackText(
      "LIVE_STREAM_ENDED",
      meta,
      "Admin User",
      "",
      "viewer",
      "th"
    );
    expect(vi.startsWith("Hệ thống đã kết thúc buổi phát trực tiếp (")).toBe(true);
    expect(th.startsWith("ระบบจบไลฟ์สตรีม (")).toBe(true);
    expect(vi).not.toContain("Admin User");
    expect(th).not.toContain("Admin User");
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
    expect(isActorLessSystemMessage("COMMUNITY_HANDLE_UPDATED")).toBe(true);
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

  it("COMMUNITY_HANDLE_UPDATED returns canonical text for any viewer", () => {
    expect(
      buildCommunitySystemFallbackText(
        "COMMUNITY_HANDLE_UPDATED",
        { actorUserId: ACTOR, actorName: "Jim Methews" },
        "Jim Methews",
        "",
        BYSTANDER
      )
    ).toBe("Community handle updated");
  });

  it("COMMUNITY_UPDATED (generic catch-all) returns the settings-updated text", () => {
    expect(
      buildCommunitySystemFallbackText("COMMUNITY_UPDATED", {}, "", "", null)
    ).toBe("Community settings updated");
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

/**
 * MEMBER_MUTED / MEMBER_UNMUTED — Telegram-style duration phrasing (Phase 5).
 * The duration is carried structurally as `metadata.durationMinutes` so clients
 * can localize; the deterministic English fallback renders "…for <duration>" for
 * timed mutes and "…indefinitely" when there is no duration.
 */
describe("formatMuteDuration — duration picker preset labels", () => {
  it("renders each picker preset to match its label", () => {
    expect(formatMuteDuration(5)).toBe("5 minutes");
    expect(formatMuteDuration(10)).toBe("10 minutes");
    expect(formatMuteDuration(30)).toBe("30 minutes");
    expect(formatMuteDuration(60)).toBe("1 hour");
    expect(formatMuteDuration(360)).toBe("6 hours");
    // 24h stays "24 hours" (NOT "1 day") to match the picker label.
    expect(formatMuteDuration(1440)).toBe("24 hours");
    expect(formatMuteDuration(10080)).toBe("7 days");
    expect(formatMuteDuration(43200)).toBe("30 days");
  });

  it("falls back to minutes for non-round values", () => {
    expect(formatMuteDuration(1)).toBe("1 minute");
    expect(formatMuteDuration(90)).toBe("90 minutes");
  });
});

describe("MEMBER_MUTED — personal message with until date/time", () => {
  // Fixed future epoch for deterministic test output. The fallback renders the
  // date via `new Date(ms).toUTCString()` — we mirror that here.
  const MUTED_UNTIL_MS = 1_800_000_000_000; // ~2027
  const MUTED_UNTIL_DATE = new Date(MUTED_UNTIL_MS).toUTCString();

  it("timed mute names actor + target + expiry for other moderators", () => {
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_MUTED",
        {
          targetUserId: TARGET,
          actorUserId: ACTOR,
          mutedUntil: MUTED_UNTIL_MS,
        },
        "Admin User",
        "Peter Parker",
        BYSTANDER
      )
    ).toBe(`Admin User muted Peter Parker until ${MUTED_UNTIL_DATE}`);
  });

  it("timed mute reads 'You are muted until <date>' for the target (PERSONAL)", () => {
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_MUTED",
        {
          targetUserId: TARGET,
          actorUserId: ACTOR,
          mutedUntil: MUTED_UNTIL_MS,
        },
        "Admin User",
        "Peter Parker",
        TARGET
      )
    ).toBe(`You are muted until ${MUTED_UNTIL_DATE}`);
  });

  it("indefinite mute (null/missing mutedUntil) reads '…indefinitely'", () => {
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_MUTED",
        { targetUserId: TARGET, actorUserId: ACTOR, mutedUntil: null },
        "Admin User",
        "Peter Parker",
        BYSTANDER
      )
    ).toBe("Admin User muted Peter Parker indefinitely");

    // missing key also degrades to indefinitely
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_MUTED",
        { targetUserId: TARGET, actorUserId: ACTOR },
        "Admin User",
        "Peter Parker",
        TARGET
      )
    ).toBe("You are muted indefinitely");
  });

  it("manual unmute reads '{actor} unmuted X' / 'You were unmuted'", () => {
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_UNMUTED",
        { targetUserId: TARGET, actorUserId: ACTOR },
        "Admin User",
        "Peter Parker",
        BYSTANDER
      )
    ).toBe("Admin User unmuted Peter Parker");
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_UNMUTED",
        { targetUserId: TARGET, actorUserId: ACTOR },
        "Admin User",
        "Peter Parker",
        TARGET
      )
    ).toBe("You were unmuted");
  });
});

describe("community moderation lines — actor reads first person", () => {
  const meta = {
    actorUserId: ACTOR,
    targetUserId: TARGET,
  };
  const render = (type: string, viewer: string, extra = {}) =>
    buildCommunitySystemFallbackText(
      type as never,
      { ...meta, ...extra },
      "Smiley Creatures",
      "Peter Parker",
      viewer
    );

  it.each([
    ["MEMBER_ADDED", "You added Peter Parker to the community", "Smiley Creatures added You to the community", "Smiley Creatures added Peter Parker to the community"],
    ["MEMBER_REMOVED", "You removed Peter Parker from the community", "Smiley Creatures removed You from the community", "Smiley Creatures removed Peter Parker from the community"],
    ["MEMBER_BANNED", "You banned Peter Parker", "You were banned from this community.", "Smiley Creatures banned Peter Parker"],
    ["MEMBER_UNBANNED", "You unbanned Peter Parker", "You were unbanned", "Smiley Creatures unbanned Peter Parker"],
    ["MEMBER_MUTED", "You muted Peter Parker indefinitely", "You are muted indefinitely", "Smiley Creatures muted Peter Parker indefinitely"],
    ["MEMBER_UNMUTED", "You unmuted Peter Parker", "You were unmuted", "Smiley Creatures unmuted Peter Parker"],
  ])("%s", (type, asActor, asTarget, asBystander) => {
    expect(render(type, ACTOR)).toBe(asActor);
    expect(render(type, TARGET)).toBe(asTarget);
    expect(render(type, BYSTANDER)).toBe(asBystander);
  });

  it("timed mute names the target and expiry for the actor", () => {
    expect(render("MEMBER_MUTED", ACTOR, { mutedUntil: 0 + 86_400_000 })).toBe(
      `You muted Peter Parker until ${new Date(86_400_000).toUTCString()}`
    );
  });
});

describe("community moderation lines — manual vs automatic actor", () => {
  const render = (
    type: string,
    metadata: Record<string, unknown>,
    viewer: string,
    locale?: "en" | "vi" | "th"
  ) =>
    buildCommunitySystemFallbackText(
      type as never,
      { targetUserId: TARGET, ...metadata },
      "Julia Doyle",
      "Boyd Stevens",
      viewer,
      locale
    );

  it("auto-unmute (source auto, system actor) names no actor for any moderator", () => {
    const auto = { actorUserId: "system", source: "auto" };
    expect(render("MEMBER_UNMUTED", auto, BYSTANDER)).toBe("Boyd Stevens was unmuted");
    expect(render("MEMBER_UNMUTED", auto, ACTOR)).toBe("Boyd Stevens was unmuted");
    expect(render("MEMBER_UNMUTED", auto, "")).toBe("Boyd Stevens was unmuted");
    // Target wording unchanged.
    expect(render("MEMBER_UNMUTED", auto, TARGET)).toBe("You were unmuted");
  });

  it("source auto wins even if a real-looking actor id is present", () => {
    expect(
      render("MEMBER_UNMUTED", { actorUserId: ACTOR, source: "auto" }, BYSTANDER)
    ).toBe("Boyd Stevens was unmuted");
  });

  it("legacy row without actorUserId stays passive", () => {
    expect(render("MEMBER_BANNED", {}, BYSTANDER)).toBe("Boyd Stevens was banned");
  });

  it("stored (no viewer) audit text names both sides", () => {
    const manual = { actorUserId: ACTOR };
    expect(render("MEMBER_MUTED", manual, "")).toBe("Julia Doyle muted Boyd Stevens indefinitely");
    expect(render("MEMBER_UNMUTED", manual, "")).toBe("Julia Doyle unmuted Boyd Stevens");
    expect(render("MEMBER_BANNED", manual, "")).toBe("Julia Doyle banned Boyd Stevens");
    expect(render("MEMBER_UNBANNED", manual, "")).toBe("Julia Doyle unbanned Boyd Stevens");
  });

  it("localizes per viewer locale (vi/th)", () => {
    const manual = { actorUserId: ACTOR };
    expect(render("MEMBER_BANNED", manual, BYSTANDER, "vi")).toBe("Julia Doyle đã cấm Boyd Stevens");
    expect(render("MEMBER_UNMUTED", manual, BYSTANDER, "th")).toBe("Julia Doyleเปิดสิทธิ์พูดให้Boyd Stevens");
    expect(
      render("MEMBER_UNMUTED", { actorUserId: "system", source: "auto" }, BYSTANDER, "vi")
    ).toBe("Boyd Stevens đã được bỏ cấm nói");
  });
});
