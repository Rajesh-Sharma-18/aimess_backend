/**
 * The translation gate, as a test so `pnpm test:all` fails on a bad catalog
 * (the standalone `pnpm validate:i18n` runs the same rules).
 *
 * Key PARITY is already a compile error — `LocalizedText` is
 * `Record<SupportedLocale, string>` — so what is worth asserting at runtime is
 * everything the type cannot see: blanks, placeholder drift between languages,
 * and untranslated copy-paste.
 */
import {
  MESSAGES,
  SUPPORTED_LOCALES,
  buildCallTimelineText,
  buildCommunitySystemFallbackText,
  buildGroupSystemFallbackText,
  buildPrivateSystemFallbackText,
  interpolate,
  resolveLocale,
  t,
  type SupportedLocale,
} from "@aimess/constants";

/**
 * Keys whose text is legitimately identical across languages (pure structure).
 *
 * Kept in step with `scripts/validate-i18n.mjs`, which enforces the same rules
 * outside Jest. `SYS_CALL_ENDED` was allowlisted there but not here, so this
 * suite failed on a key the project had already decided was correct.
 */
const IDENTICAL_ALLOWED = new Set([
  "SYS_COMMUNITY_LIVESTREAM_ENDED_DURATION",
  "NOTIF_CHAT_COMMUNITY_BODY",
  // "{{label}} {{duration}}" — the completed-call preview. The label is itself
  // a translated string, so there is no prose here to translate.
  "SYS_CALL_ENDED",
]);

const placeholders = (text: string): string =>
  [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

describe("i18n catalog", () => {
  it("supports exactly en, vi and th", () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual(["en", "th", "vi"]);
  });

  it("has a non-blank string for every key in every locale", () => {
    const blanks: string[] = [];
    for (const [key, entry] of Object.entries(MESSAGES)) {
      for (const locale of SUPPORTED_LOCALES) {
        const value = (entry as Record<string, string>)[locale];
        if (typeof value !== "string" || !value.trim()) {
          blanks.push(`${key}.${locale}`);
        }
      }
    }
    expect(blanks).toEqual([]);
  });

  it("uses the same placeholders in every locale", () => {
    const drift: string[] = [];
    for (const [key, entry] of Object.entries(MESSAGES)) {
      const e = entry as Record<string, string>;
      const reference = placeholders(e.en ?? "");
      for (const locale of SUPPORTED_LOCALES) {
        if (locale === "en") continue;
        if (placeholders(e[locale] ?? "") !== reference) {
          drift.push(`${key}.${locale}`);
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it("never leaves a non-English value byte-identical to English", () => {
    const untranslated: string[] = [];
    for (const [key, entry] of Object.entries(MESSAGES)) {
      if (IDENTICAL_ALLOWED.has(key)) continue;
      const e = entry as Record<string, string>;
      for (const locale of SUPPORTED_LOCALES) {
        if (locale === "en") continue;
        if (e[locale] === e.en) untranslated.push(`${key}.${locale}`);
      }
    }
    expect(untranslated).toEqual([]);
  });

  it("never surfaces a raw key to a user", () => {
    // `t` returns the key itself only for keys that are not in the catalog —
    // proving no catalog key resolves to its own name in any locale.
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of Object.keys(MESSAGES)) {
        expect(t(key as never, locale)).not.toBe(key);
      }
    }
  });
});

describe("locale resolution", () => {
  it.each([
    ["th", "th"],
    ["th-TH", "th"],
    ["vi", "vi"],
    ["en-GB", "en"],
    ["th-TH,th;q=0.9,en;q=0.8", "th"],
  ])("resolves x-lang %s to %s", (header, expected) => {
    expect(resolveLocale(null, header)).toBe(expected);
  });

  it("prefers x-lang over Accept-Language", () => {
    expect(resolveLocale("en-US,en;q=0.9", "th")).toBe("th");
  });

  it("falls back to Accept-Language when x-lang is absent", () => {
    expect(resolveLocale("vi-VN,vi;q=0.9", null)).toBe("vi");
  });

  it("leaves an unknown placeholder visible instead of blanking it", () => {
    expect(interpolate("hello {{who}}", {})).toBe("hello {{who}}");
  });
});

describe("system message rendering per locale", () => {
  const data = {
    actorName: "Alex",
    targetName: "Jim",
    actorId: "a1",
    targetUserId: "t1",
  };

  it("renders a group removal in all three languages", () => {
    const en = buildGroupSystemFallbackText("MEMBER_REMOVED", data, null, "en");
    const vi = buildGroupSystemFallbackText("MEMBER_REMOVED", data, null, "vi");
    const th = buildGroupSystemFallbackText("MEMBER_REMOVED", data, null, "th");
    expect(en).toBe("Alex removed Jim");
    expect(new Set([en, vi, th]).size).toBe(3);
    for (const text of [en, vi, th]) {
      expect(text).toContain("Alex");
      expect(text).toContain("Jim");
    }
  });

  it("keeps the first-person form per viewer inside each language", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", data, "t1", "th")
    ).toBe(t("SYS_GROUP_MEMBER_REMOVED_SELF", "th"));
    expect(
      buildGroupSystemFallbackText("MEMBER_REMOVED", data, "t1", "vi")
    ).toBe(t("SYS_GROUP_MEMBER_REMOVED_SELF", "vi"));
  });

  it("defaults to English so stored SYSTEM text never shifts language", () => {
    expect(buildGroupSystemFallbackText("MEMBER_REMOVED", data)).toBe(
      "Alex removed Jim"
    );
    expect(
      buildPrivateSystemFallbackText("FRIENDSHIP_BLOCKED", {
        actorName: "Alex",
        targetName: "Jim",
      })
    ).toBe("Alex blocked Jim");
    expect(
      buildCommunitySystemFallbackText("MEMBER_BANNED", {}, "Alex", "Jim")
    ).toBe("Jim was banned");
    expect(buildCallTimelineText({ callType: "VIDEO", status: "MISSED" })).toBe(
      "Video call was not answered"
    );
  });

  it("localizes call rows", () => {
    const locales: SupportedLocale[] = ["en", "vi", "th"];
    const rendered = locales.map((locale) =>
      buildCallTimelineText({ callType: "VOICE", status: "DECLINED", locale })
    );
    expect(new Set(rendered).size).toBe(3);
  });
});
