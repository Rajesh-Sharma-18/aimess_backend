/**
 * Server-side mirror of the canonical AIMESS link grammar
 * (DEEP_LINKING_INTEGRATION.md §3). MUST stay behaviourally identical to the
 * Android and Web implementations so a shared link resolves the same way
 * everywhere:
 *
 *   Android  aimess_native_android/.../deeplink/CommunityLink.kt
 *   Web      aimess_website/src/utils/linkGrammar.ts
 *
 *   /+<code>                private community invite
 *   /g/<token>              group invite
 *   /community/@<handle>    public community (canonical)
 *   /community/<handle>     public community (`@` optional)
 *   /<handle>               public community (legacy pretty link)
 *   anything else           NOT ours — the marketing site
 *
 * `+` and `@` are display markers only; both are stripped before the value is
 * used.
 */
export type LinkTarget =
  | { kind: "public"; handle: string }
  | { kind: "private"; code: string }
  | { kind: "group"; token: string }
  /** Inside our path space but malformed → 404 page, never a browser bounce. */
  | { kind: "invalid" };

/** Handle charset/length per spec §3.2 (`^[a-z0-9_]{3,32}$` — min loosened from
 *  the original 5 to stay compatible with existing 3–4 char handles). */
const HANDLE_RE = /^[a-z0-9_]{3,32}$/;
/** Invite code / group token charset per spec §3.2 (base64url, 1–100). */
const CODE_RE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Bare single segments that are marketing routes, never a handle. The charset
 * already excludes every hyphenated route (`terms-of-service`,
 * `privacy-policy`), so only un-hyphenated names need an entry. Keep in sync
 * with the web and Android lists (spec §3.3).
 */
const RESERVED_SEGMENTS = new Set([
  "about",
  "api",
  "app",
  "auth",
  "blog",
  "community",
  "contact",
  "docs",
  "download",
  "help",
  "invite",
  "link",
  "login",
  "message",
  "notifications",
  "pricing",
  "privacy",
  "register",
  "settings",
  "signup",
  "support",
  "terms",
  "web",
]);

/**
 * Second segments under `/community/` that are the web app's own pages, not a
 * handle. Only the bare `/community/<handle>` form can collide — `/community/@x`
 * is unambiguous. Mirrors the web's `COMMUNITY_SUBROUTES`.
 */
const COMMUNITY_SUBROUTES = new Set(["create", "invite"]);

const asPrivate = (raw: string): LinkTarget =>
  CODE_RE.test(raw) ? { kind: "private", code: raw } : { kind: "invalid" };

const asGroup = (raw: string): LinkTarget =>
  CODE_RE.test(raw) ? { kind: "group", token: raw } : { kind: "invalid" };

const asPublic = (raw: string): LinkTarget => {
  const handle = raw.toLowerCase();
  return HANDLE_RE.test(handle)
    ? { kind: "public", handle }
    : { kind: "invalid" };
};

/**
 * THE owner of the grammar. Takes already-URL-decoded path segments.
 *
 * Returns `null` when the path is NOT in the AIMESS link space — the caller
 * must hand it to the marketing site untouched. Collapsing that into `invalid`
 * is what would make AIMESS hijack its own `/terms-of-service` (spec §7.5).
 *
 * Charset validation here is also the first line of XSS defence: neither
 * charset permits `<`, `>`, `"` or `/`, so a returned value can be interpolated
 * into HTML after escaping.
 */
export function detectFromPath(rawSegments: string[]): LinkTarget | null {
  const segments = rawSegments.filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const [first, second] = segments;

  // The whole `/g/` prefix is ours, so `/g/` alone is an in-app error, not a
  // browser bounce.
  if (first === "g") {
    if (segments.length !== 2) return { kind: "invalid" };
    return asGroup(second as string);
  }

  if (first === "community") {
    if (segments.length !== 2) return null; // /community/create, /community/invite/<code>, …
    const seg = second as string;
    if (seg.startsWith("@")) return asPublic(seg.slice(1));
    return COMMUNITY_SUBROUTES.has(seg.toLowerCase()) ? null : asPublic(seg);
  }

  if (segments.length !== 1) return null;

  const bare = (first as string).trim();
  if (bare.startsWith("+")) return asPrivate(bare.slice(1));
  if (RESERVED_SEGMENTS.has(bare.toLowerCase())) return null;

  // A bare segment is ours only if it IS a handle; anything else is a marketing
  // route we have never heard of.
  const target = asPublic(bare);
  return target.kind === "public" ? target : null;
}

/**
 * Detect from a raw first path segment (already URL-decoded). Kept for callers
 * that only ever see one segment; delegates to `detectFromPath` so there is one
 * grammar. Note it returns `invalid` (not `null`) for a non-link segment,
 * preserving the original contract.
 */
export function detectFromSegment(segment: string | undefined): LinkTarget {
  return detectFromPath([(segment ?? "").trim()]) ?? { kind: "invalid" };
}

/** Detect from a full URL (https://<link-host>/... or aimess://...). */
export function detectLink(raw: string): LinkTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid" };
  }

  if (url.protocol === "aimess:") {
    // Some launchers surface the action as the first path segment rather than
    // the host, so `aimess:///resolve?…` must parse too (spec §3.5).
    const action = (
      url.host ||
      url.pathname.replace(/^\/+/, "").split("/")[0] ||
      ""
    ).toLowerCase();
    const code = url.searchParams.get("code");
    const handle = url.searchParams.get("handle");
    const token = url.searchParams.get("token");

    if (action === "joingroup" || action === "join-group" || token) {
      return token ? asGroup(token) : { kind: "invalid" };
    }
    if (action === "join" || code) {
      return code ? asPrivate(code) : { kind: "invalid" };
    }
    if (action === "resolve" || handle) {
      return handle ? asPublic(handle) : { kind: "invalid" };
    }
    return { kind: "invalid" };
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    });
  return detectFromPath(segments) ?? { kind: "invalid" };
}

/** Deferred-deep-link store referrer token: `h_<handle>` / `p_<code>` / `g_<token>` (§6.4). */
export function deferredToken(target: LinkTarget): string {
  if (target.kind === "public") return `h_${target.handle}`;
  if (target.kind === "private") return `p_${target.code}`;
  if (target.kind === "group") return `g_${target.token}`;
  return "";
}
