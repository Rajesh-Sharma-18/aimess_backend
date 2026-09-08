import { randomBytes } from "node:crypto";
import { timingSafeEqual } from "node:crypto";

/**
 * The two identifiers a livestream has, and why they must be different.
 *
 * `streamKey` is the publish CREDENTIAL: whoever holds it can publish to the
 * stream, and `on_publish` authenticates on it alone.
 *
 * `playbackId` is the PUBLIC name: it is the path segment of the HLS, FLV and
 * DASH URLs handed to every viewer, and it appears in the join ack, the
 * community "stream started" broadcast and the admin monitor.
 *
 * They used to be one value. That meant the publish credential was printed in
 * every viewer's player URL: open the network tab, copy the name out of
 * `…/live/<name>.m3u8`, point OBS at `rtmp://host/live/<name>`, and take over
 * the broadcast. Any viewer of any stream could do it, including one who had
 * been banned from the community.
 *
 * SRS serves media strictly under the name a stream is PUBLISHED as, and its
 * hooks can only allow or deny — they cannot rename. So the split is the other
 * way round from the obvious one: publish under the public `playbackId`, and
 * carry the secret as a query parameter on the publish URL, which SRS passes
 * through to the hook in `param`. Playback URLs then contain only the public
 * id, and the secret never reaches a viewer.
 */

/** A new publish credential. 16 bytes — this is the value that must not be guessable. */
export function generateStreamKey(): string {
  return randomBytes(16).toString("hex");
}

/** A new public playback name. Distinct from the key, and safe to hand out. */
export function generatePlaybackId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * The name SRS knows a stream by.
 *
 * New rows publish under `playbackId`. Rows created before the split have none,
 * and SRS knows them by their `streamKey` — so that is what must be used to
 * look them up, build their URLs, and match them in the SRS API. Without this
 * fallback, every stream that was live across the deploy would become
 * unreachable.
 */
export function resolveSrsName(stream: {
  streamKey: string;
  playbackId?: string | null;
}): string {
  return stream.playbackId ?? stream.streamKey;
}

/**
 * Parse the publish secret out of the query string SRS forwards.
 *
 * SRS puts the publish URL's query string in the hook's `param` field, with a
 * leading `?`. RTMP publishers send `rtmp://host/live/<id>?secret=…`; WHIP
 * sends it as part of the endpoint query.
 */
export function extractPublishSecret(param: string | undefined): string {
  if (!param) return "";
  const query = param.startsWith("?") ? param.slice(1) : param;
  try {
    return new URLSearchParams(query).get("secret") ?? "";
  } catch {
    return "";
  }
}

/**
 * Constant-time comparison of the presented publish secret against the stored
 * key. Length is compared first because `timingSafeEqual` throws on a mismatch.
 */
export function publishSecretMatches(
  presented: string,
  expected: string
): boolean {
  if (presented.length === 0 || presented.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}
