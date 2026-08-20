/**
 * THE tick resolver — the one place SENT / DELIVERED / READ is decided.
 *
 * Two surfaces render the same fact about the same message: the bubble in the
 * open chatroom and the `lastActivity` preview in the inbox list. They used to
 * decide it separately — the list folded per-member watermarks here on the
 * server, while the transcript shipped the raw cursors and let the client
 * decide — so the same message could sit on ✓ in one place and ✓✓ blue in the
 * other. Everything now folds through this function, and the cursors handed to
 * the client are the SAME settings-gated numbers this fold is given.
 *
 * Inputs are watermarks, never booleans: a reader "has read" message M exactly
 * when their read cursor's `sequenceNumber >= M.sequenceNumber` (see
 * `read-receipts.ts` for why there is no per-message read table).
 *
 * Settings → Chat → Read Receipt is applied by the CALLER, by shaping
 * `readSeqs`: a viewer who cannot see receipts passes an empty array, and a
 * member who gives none is passed as `0`. Keeping them in the array at 0 — not
 * dropping them — is what stops "everyone else read it" from being satisfied by
 * the members who happen to broadcast.
 */
export type TickStatus = "SENT" | "DELIVERED" | "READ";

export function foldTickStatus(params: {
  /** `sequenceNumber` of the message the tick belongs to. */
  seq: number;
  /** How many OTHER active members must read it before it turns blue. */
  otherCount: number;
  /** Every other member's read watermark. Empty = receipts not visible. */
  readSeqs: readonly number[];
  /** Every other member's delivery watermark. */
  deliveredSeqs: readonly number[];
}): TickStatus {
  const { seq, otherCount, readSeqs, deliveredSeqs } = params;
  // COUNT, not `every`: callers hand one entry per other member (zeroes
  // included), so "otherCount of them are at/past seq" IS "all of them" — and
  // counting stays correct for a client whose cursor map still holds someone
  // who has since left the room.
  if (
    seq > 0 &&
    otherCount > 0 &&
    readSeqs.filter((s) => s >= seq).length >= otherCount
  ) {
    return "READ";
  }
  // `seq > 0` guards the DELIVERED tier too: a row with no server sequence yet
  // would otherwise be "delivered" against any cursor at all, since every
  // watermark is trivially >= 0.
  return seq > 0 && deliveredSeqs.some((s) => s >= seq) ? "DELIVERED" : "SENT";
}
