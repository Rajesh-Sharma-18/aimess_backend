/**
 * Hosts allowed to serve an attachment we did not store ourselves.
 *
 * The attachment guard skips verification for any value that merely looks like
 * an http(s) URL, on the reasoning that it is "an external provider — not our
 * object". The intent was the GIF and sticker providers, but with no host
 * check, ANY sender could post a message whose attachment pointed at
 * `https://attacker.example/beacon.png`. Every recipient's client then fetched
 * attacker-controlled content the moment the message rendered: no magic-byte
 * validation, no antivirus scan, no size cap — and the attacker's host learned
 * each recipient's address, user agent and read timing. The same field reaches
 * push payloads.
 *
 * Subdomains are matched, so `media.giphy.com` and `i.giphy.com` both pass
 * under `giphy.com`, but `giphy.com.attacker.example` does not.
 */
export const EXTERNAL_MEDIA_HOSTS: readonly string[] = [
  "giphy.com",
  "tenor.com",
  "googleusercontent.com",
];

/** True when `hostname` is one of the allowed hosts, or a subdomain of one. */
export function isAllowedExternalMediaHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return EXTERNAL_MEDIA_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

/** Parse a URL, returning null instead of throwing on a malformed value. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** True when the value parses as a URL whose scheme is http or https. */
export function isHttpUrl(value: string): boolean {
  const url = parseUrl(value);
  return (
    url !== null && (url.protocol === "http:" || url.protocol === "https:")
  );
}

/** True when the value is an http(s) URL served by an allowed external host. */
export function isAllowedExternalMediaUrl(value: string): boolean {
  const url = parseUrl(value);
  if (url === null) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isAllowedExternalMediaHost(url.hostname);
}
