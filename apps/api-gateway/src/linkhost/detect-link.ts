/**
 * Server-side mirror of the canonical `detectLink()` from the Community Sharing
 * & Deep-Linking spec (§4.2). MUST stay byte-for-byte equivalent in behavior to
 * the Android/iOS/Web implementations so a link resolves identically everywhere.
 *
 *   PUBLIC   →  aimess.me/<handle>     (bare first segment)
 *   PRIVATE  →  aimess.me/+<code>      (first segment starts with `+`)
 *
 * The `+` is a URL marker only — it is stripped before the code is used.
 */
export type LinkTarget =
  | { kind: "public"; handle: string }
  | { kind: "private"; code: string }
  | { kind: "invalid" };

/** Handle charset/length per spec §4.1 (`^[a-z0-9_]{5,32}$`), min loosened to 3
 *  to stay compatible with existing 3–4 char handles. */
const HANDLE_RE = /^[a-z0-9_]{3,32}$/;
/** Invite code charset per spec §4.1 (base64url, 1–100). */
const CODE_RE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Detect from a raw first path segment (already URL-decoded). Charset-validated:
 * a segment that doesn't match the handle/code grammar is `invalid`. This is
 * also the first line of defense against injecting markup into the preview page
 * — neither charset permits `<`, `>`, `"`, or `/`.
 */
export function detectFromSegment(segment: string | undefined): LinkTarget {
  const seg = (segment ?? "").trim();
  if (!seg) return { kind: "invalid" };
  if (seg.startsWith("+")) {
    const code = seg.slice(1);
    return code && CODE_RE.test(code)
      ? { kind: "private", code }
      : { kind: "invalid" };
  }
  return HANDLE_RE.test(seg)
    ? { kind: "public", handle: seg }
    : { kind: "invalid" };
}

/** Detect from a full URL (https://aimess.me/... or aimess://...). */
export function detectLink(raw: string): LinkTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid" };
  }

  if (url.protocol === "aimess:") {
    const code = url.searchParams.get("code");
    const handle = url.searchParams.get("handle");
    if (url.host === "join" || code) {
      return code ? { kind: "private", code } : { kind: "invalid" };
    }
    if (url.host === "resolve" || handle) {
      return handle ? { kind: "public", handle } : { kind: "invalid" };
    }
    return { kind: "invalid" };
  }

  const seg = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  return detectFromSegment(decodeURIComponent(seg));
}

/** Deferred-deep-link store referrer token: `h_<handle>` / `p_<code>` (§4.1/§8). */
export function deferredToken(target: LinkTarget): string {
  if (target.kind === "public") return `h_${target.handle}`;
  if (target.kind === "private") return `p_${target.code}`;
  return "";
}
