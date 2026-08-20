import { env } from "../config/env.js";
import { deferredToken, type LinkTarget } from "./detect-link.js";

/**
 * Card data rendered on the interstitial. A PUBLIC community card and a GROUP
 * invite card are the same shape here — only `unfurl` differs (see below).
 */
export interface PreviewCard {
  name: string;
  description: string | null;
  avatarUrl: string | null;
  bannerUrl?: string | null;
  memberCount: number;
}

/** HTML-escape untrusted text before interpolation. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a value for embedding inside an inline `<script>`. `JSON.stringify`
 * alone does NOT neutralize the literal `</script>` substring, so escape the
 * markup-significant characters (`<`, `>`, `&`) for the script context.
 * Defense-in-depth on top of the charset validation in `detectFromSegment`.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * Path to hand to the web app for this target. Same canonical shape the link
 * host itself serves (`/+<code>` for a private code, `/<handle>` for a public
 * one) — the web app maps both onto its own routes. `""` for an invalid target,
 * which never reaches the "Continue on web" button anyway.
 */
function webTargetPath(target: LinkTarget): string {
  if (target.kind === "private") return `/+${encodeURIComponent(target.code)}`;
  if (target.kind === "group") return `/g/${encodeURIComponent(target.token)}`;
  if (target.kind === "public") return `/${encodeURIComponent(target.handle)}`;
  return "";
}

interface PreviewOptions {
  target: LinkTarget;
  /** Non-null for a resolvable PUBLIC handle or a live GROUP invite token. */
  card: PreviewCard | null;
  /**
   * Whether this card may go into the OG/Twitter tags. TRUE only for PUBLIC
   * communities: a group invite link pasted into a chat would otherwise unfurl
   * the group's name, avatar and member count to everyone in that chat, so a
   * group renders its real metadata on the PAGE (the visitor holds the token)
   * but keeps generic tags for crawlers (spec §14/§16).
   */
  unfurl: boolean;
  /** Absolute URL of this preview page (for og:url). */
  pageUrl: string;
}

/**
 * Server-rendered community link preview / "Open in app" interstitial
 * (spec §7.3 / §8.1 / F3·F7·F16). PUBLIC handles render a full metadata card so
 * shared links unfurl; PRIVATE codes render a generic card (no metadata leak to
 * logged-out viewers). Inline JS performs platform-aware app handoff with a
 * deferred-deep-link store fallback.
 */
export function renderPreviewPage(opts: PreviewOptions): string {
  const { target, card, pageUrl, unfurl } = opts;

  const isPrivate = target.kind === "private";
  const isGroup = target.kind === "group";
  const genericTitle = isPrivate
    ? "Private community invite"
    : isGroup
      ? "Group invite on AIMESS"
      : "AIMESS community";
  const genericDescription = isPrivate
    ? "You've been invited to a private community on AIMESS. Open the app to request to join."
    : isGroup
      ? "You've been invited to a group chat on AIMESS. Open the app to join."
      : "Join this community on AIMESS.";
  const title = card?.name ?? genericTitle;
  // A description identical to the name renders the same string twice.
  const about =
    card && card.description?.trim() !== card.name.trim()
      ? card.description
      : null;
  const description = about ?? genericDescription;
  const memberLine =
    card != null ? `${card.memberCount.toLocaleString()} members` : "";

  // Crawler-facing values. Never the group's own metadata — see `unfurl`.
  const ogTitle = unfurl ? title : genericTitle;
  const ogDescription = unfurl ? description : genericDescription;
  const image = unfurl ? (card?.bannerUrl ?? card?.avatarUrl ?? "") : "";

  const token = deferredToken(target);
  const clientConfig = {
    kind: target.kind,
    handle: target.kind === "public" ? target.handle : "",
    code: target.kind === "private" ? target.code : "",
    groupToken: target.kind === "group" ? target.token : "",
    token,
    scheme: env.APP_SCHEME,
    androidPackage: env.ANDROID_PACKAGE_NAME,
    androidStoreAppId: env.ANDROID_STORE_APP_ID ?? "",
    appleStoreAppId: env.APPLE_STORE_APP_ID ?? "",
    webAppUrl: env.WEB_APP_URL,
    // "Continue on web" must land on the TARGET, not on a bare login page: the
    // web app serves the same canonical `/+<code>` / `/<handle>` shapes and
    // routes them to the invite preview itself. A logged-out visitor is bounced
    // through login by the web app's own guard, which carries the path in
    // `?redirect=` and returns here after auth — so the code is never lost, and
    // an already-signed-in visitor is not made to sign in again.
    webTarget: webTargetPath(target),
  };

  const ogImageTag = image
    ? `<meta property="og:image" content="${esc(image)}"/>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(ogTitle)}</title>
<meta property="og:title" content="${esc(ogTitle)}"/>
<meta property="og:description" content="${esc(ogDescription)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${esc(pageUrl)}"/>
${ogImageTag}
<meta name="twitter:card" content="summary_large_image"/>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1115;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{max-width:420px;width:100%;background:#171a21;border:1px solid #232733;border-radius:16px;padding:28px;text-align:center}
  .avatar{width:88px;height:88px;border-radius:24px;object-fit:cover;margin:0 auto 16px;background:#232733;display:flex;align-items:center;justify-content:center;font-size:34px}
  h1{font-size:20px;margin:0 0 6px}
  .meta{color:#9aa4b2;font-size:14px;margin:0 0 4px}
  .desc{color:#c4ccd6;font-size:15px;margin:12px 0 20px;line-height:1.45}
  .lock{display:inline-block;margin-bottom:8px;color:#f0b429;font-size:13px}
  button{display:block;width:100%;border:0;border-radius:12px;padding:14px;font-size:16px;font-weight:600;cursor:pointer;margin-top:10px}
  .primary{background:#3b82f6;color:#fff}
  .secondary{background:transparent;color:#9aa4b2;text-decoration:underline}
</style>
</head>
<body>
  <div class="card">
    ${
      card?.avatarUrl
        ? `<img class="avatar" src="${esc(card.avatarUrl)}" alt=""/>`
        : `<div class="avatar">${isPrivate ? "🔒" : isGroup ? "💬" : "👥"}</div>`
    }
    ${isPrivate ? '<div class="lock">🔒 Private community</div>' : ""}
    ${isGroup ? '<div class="lock">💬 Group invite</div>' : ""}
    <h1>${esc(title)}</h1>
    ${memberLine ? `<p class="meta">${esc(memberLine)}</p>` : ""}
    <p class="desc">${esc(description)}</p>
    <button class="primary" id="open">Open in app</button>
    <button class="secondary" id="web">Continue on web</button>
  </div>
<script>
(function(){
  var CFG = ${scriptJson(clientConfig)};
  function continueOnWeb(){
    // Straight to the target on the web app — it owns the auth round-trip.
    location.href = CFG.webAppUrl + (CFG.webTarget || "");
  }
  function openInApp(){
    var ua = navigator.userAgent || "";
    if (/Android/i.test(ua)) {
      var fallback = CFG.androidStoreAppId
        ? "https://play.google.com/store/apps/details?id=" + CFG.androidPackage + "&referrer=" + encodeURIComponent(CFG.token)
        : CFG.webAppUrl + (CFG.webTarget || "");
      var extra = CFG.kind === "private" ? "S.code=" + CFG.code
                : CFG.kind === "group"   ? "S.token=" + CFG.groupToken
                : CFG.kind === "public"  ? "S.handle=" + CFG.handle : "";
      location.href = "intent://open#Intent;scheme=" + CFG.scheme + ";package=" + CFG.androidPackage + ";" +
        (extra ? extra + ";" : "") +
        "S.browser_fallback_url=" + encodeURIComponent(fallback) + ";end";
      return;
    }
    if (/iPhone|iPad|iPod/i.test(ua)) {
      var appUrl = CFG.kind === "private"
        ? CFG.scheme + "://join?code=" + encodeURIComponent(CFG.code)
        : CFG.kind === "group"
        ? CFG.scheme + "://joingroup?token=" + encodeURIComponent(CFG.groupToken)
        : CFG.scheme + "://resolve?handle=" + encodeURIComponent(CFG.handle);
      var store = CFG.appleStoreAppId ? "https://apps.apple.com/app/id" + CFG.appleStoreAppId : CFG.webAppUrl + (CFG.webTarget || "");
      var t = setTimeout(function(){ location.href = store; }, 1200);
      window.addEventListener("pagehide", function(){ clearTimeout(t); });
      location.href = appUrl;
      return;
    }
    continueOnWeb();
  }
  document.getElementById("open").addEventListener("click", openInApp);
  document.getElementById("web").addEventListener("click", continueOnWeb);
})();
</script>
</body>
</html>`;
}
