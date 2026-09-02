import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time compare of two possibly-different-length strings.
 *
 * Length is not itself secret here (both sides are fixed-width hex), but the
 * comparison still runs on the mismatched path so a caller cannot distinguish
 * "wrong length" from "wrong value" by timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Short, non-reversible tag for a stream key or publish secret, safe to write
 * to the production log.
 *
 * The SRS hooks fire several times per broadcast plus once per viewer
 * (`on_play`), so logging the raw value would scatter it across the logs of
 * every environment that ships them. A truncated SHA-256 still lets an operator
 * correlate lines for one stream without handing a log reader anything
 * publishable.
 */
export function digestKey(value: string | null | undefined): string {
  if (!value) return "none";
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}
