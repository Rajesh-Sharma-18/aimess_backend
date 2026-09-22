/**
 * COMMUNITY_PRIVACY_CHANGED wording + the actor-aware / viewer-aware rules.
 *
 * One stored row, several readers: the actor ("You changed …"), any other
 * member and the Super Admin viewer (no viewer id → factual "{actor} changed …").
 * Also pins the legacy COMMUNITY_UPDATED fallback so historical rows render
 * safely without inventing an actor that was never stored.
 */
import {
  buildCommunitySystemFallbackText,
  buildCommunitySystemSelfPreview,
  isActorLessSystemMessage,
  isEligibleForLastActivity,
  personalizeCommunitySystemMessageForViewer,
  resolveCommunitySystemSubjectUserId,
  sanitizeCommunitySystemMetadata,
  CommunitySystemMessageType,
  SYSTEM_MESSAGE_VISIBILITY,
} from "@aimess/constants";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NAME = "Smiley Creatures";

const row = (from: string, to: string) => ({
  actorUserId: ACTOR,
  actorName: NAME,
  oldVisibility: from,
  newVisibility: to,
});

const render = (
  meta: Record<string, unknown>,
  viewer: string | null,
  locale: "en" | "vi" | "th" = "en"
) =>
  buildCommunitySystemFallbackText(
    "COMMUNITY_PRIVACY_CHANGED",
    meta,
    NAME,
    "",
    viewer,
    locale
  );

describe("COMMUNITY_PRIVACY_CHANGED — PUBLIC → PRIVATE", () => {
  const meta = row("PUBLIC", "PRIVATE");
  it("actor reads first-person", () => {
    expect(render(meta, ACTOR)).toBe("You changed the community to private");
  });
  it("another member reads the actor's display name", () => {
    expect(render(meta, MEMBER)).toBe(
      "Smiley Creatures changed the community to private"
    );
  });
  it("Super Admin (no viewer id) never sees 'You'", () => {
    expect(render(meta, null)).toBe(
      "Smiley Creatures changed the community to private"
    );
    expect(render(meta, "")).not.toMatch(/^You/);
  });
});

describe("COMMUNITY_PRIVACY_CHANGED — PRIVATE → PUBLIC", () => {
  const meta = row("PRIVATE", "PUBLIC");
  it("actor reads first-person", () => {
    expect(render(meta, ACTOR)).toBe("You changed the community to public");
  });
  it("another member reads the actor's display name", () => {
    expect(render(meta, MEMBER)).toBe(
      "Smiley Creatures changed the community to public"
    );
  });
  it("Super Admin viewer reads the factual actor line", () => {
    expect(render(meta, null)).toBe(
      "Smiley Creatures changed the community to public"
    );
  });
});

describe("COMMUNITY_PRIVACY_CHANGED — localization", () => {
  it("vi", () => {
    expect(render(row("PUBLIC", "PRIVATE"), ACTOR, "vi")).toBe(
      "Bạn đã chuyển cộng đồng sang riêng tư"
    );
    expect(render(row("PRIVATE", "PUBLIC"), MEMBER, "vi")).toBe(
      "Smiley Creatures đã chuyển cộng đồng sang công khai"
    );
  });
  it("th", () => {
    expect(render(row("PUBLIC", "PRIVATE"), ACTOR, "th")).toBe(
      "คุณเปลี่ยนคอมมูนิตี้เป็นแบบส่วนตัว"
    );
    expect(render(row("PRIVATE", "PUBLIC"), null, "th")).toBe(
      "Smiley Creatures เปลี่ยนคอมมูนิตี้เป็นแบบสาธารณะ"
    );
  });
  it("no raw keys or unfilled placeholders in any locale", () => {
    for (const locale of ["en", "vi", "th"] as const) {
      for (const [from, to] of [
        ["PUBLIC", "PRIVATE"],
        ["PRIVATE", "PUBLIC"],
      ] as const) {
        for (const viewer of [ACTOR, MEMBER, null]) {
          expect(render(row(from, to), viewer, locale)).not.toMatch(
            /SYS_|\{\{|\}\}/
          );
        }
      }
    }
  });
});

describe("COMMUNITY_PRIVACY_CHANGED — contract / safety", () => {
  it("is a registered, COMMUNITY-visible, list-bumping, actor-bearing type", () => {
    expect(CommunitySystemMessageType.COMMUNITY_PRIVACY_CHANGED).toBe(
      "COMMUNITY_PRIVACY_CHANGED"
    );
    expect(SYSTEM_MESSAGE_VISIBILITY.COMMUNITY_PRIVACY_CHANGED).toBe(
      "COMMUNITY"
    );
    expect(isEligibleForLastActivity("COMMUNITY_PRIVACY_CHANGED")).toBe(true);
    expect(isActorLessSystemMessage("COMMUNITY_PRIVACY_CHANGED")).toBe(false);
    // Actor identity survives sanitization so clients can render "You".
    expect(
      sanitizeCommunitySystemMetadata(
        "COMMUNITY_PRIVACY_CHANGED",
        row("PUBLIC", "PRIVATE")
      )
    ).toMatchObject({ actorUserId: ACTOR, actorName: NAME });
  });

  it("list preview is personalized for the actor only", () => {
    const meta = row("PUBLIC", "PRIVATE");
    expect(
      resolveCommunitySystemSubjectUserId(
        "COMMUNITY_PRIVACY_CHANGED",
        meta,
        ACTOR
      )
    ).toBe(ACTOR);
    expect(
      buildCommunitySystemSelfPreview(
        "COMMUNITY_PRIVACY_CHANGED",
        meta,
        NAME,
        "",
        ACTOR
      )
    ).toBe("You changed the community to private");
  });

  it("per-viewer rewrite of the stored third-person text", () => {
    const meta = row("PRIVATE", "PUBLIC");
    const stored = render(meta, null);
    expect(
      personalizeCommunitySystemMessageForViewer(
        "COMMUNITY_PRIVACY_CHANGED",
        meta,
        stored,
        NAME,
        "",
        ACTOR
      )
    ).toBe("You changed the community to public");
    expect(
      personalizeCommunitySystemMessageForViewer(
        "COMMUNITY_PRIVACY_CHANGED",
        meta,
        stored,
        NAME,
        "",
        MEMBER
      )
    ).toBe(stored);
  });

  it("missing newVisibility never claims a direction", () => {
    expect(render({ actorUserId: ACTOR, actorName: NAME }, ACTOR)).toBe(
      "Community settings updated"
    );
  });

  it("unresolved actor name falls back to 'Someone', never 'undefined'", () => {
    expect(
      buildCommunitySystemFallbackText(
        "COMMUNITY_PRIVACY_CHANGED",
        { actorUserId: ACTOR, newVisibility: "PRIVATE" },
        "",
        "",
        MEMBER
      )
    ).toBe("Someone changed the community to private");
  });
});

describe("COMMUNITY_UPDATED — historical rows + single-field wording", () => {
  const legacy = (changedFields: string[], newVisibility?: string) =>
    buildCommunitySystemFallbackText(
      "COMMUNITY_UPDATED",
      { changedFields, ...(newVisibility ? { newVisibility } : {}) },
      "",
      "",
      MEMBER
    );

  it("legacy visibility-only row states the direction, with no actor", () => {
    expect(legacy(["visibility"], "PRIVATE")).toBe(
      "Community changed to private"
    );
    expect(legacy(["visibility"], "PUBLIC")).toBe(
      "Community changed to public"
    );
  });

  it("legacy row without the metadata stays generic (nothing fabricated)", () => {
    expect(legacy(["visibility"])).toBe("Community settings updated");
    expect(
      buildCommunitySystemFallbackText("COMMUNITY_UPDATED", {}, "", "", null)
    ).toBe("Community settings updated");
  });

  it("multi-field row stays generic even if visibility was among them", () => {
    expect(legacy(["visibility", "category"], "PRIVATE")).toBe(
      "Community settings updated"
    );
  });

  it("category-only change is named", () => {
    expect(legacy(["category"])).toBe("Community category updated");
    expect(
      buildCommunitySystemFallbackText(
        "COMMUNITY_UPDATED",
        { changedFields: ["category"] },
        "",
        "",
        null,
        "vi"
      )
    ).toBe("Danh mục cộng đồng đã được cập nhật");
  });
});
