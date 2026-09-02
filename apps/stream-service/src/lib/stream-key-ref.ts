import { createHash } from "node:crypto";

/**
 * A log-safe reference to a stream key.
 *
 * The key is the sole publish credential — `handlePublish` authenticates on it
 * and nothing else — so printing it verbatim put a broadcast-takeover value
 * into the log pipeline. The digest is stable, so operators can still correlate
 * lines about one stream.
 */
export function streamKeyRef(key: string | undefined | null): string {
  if (!key) return "?";
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
