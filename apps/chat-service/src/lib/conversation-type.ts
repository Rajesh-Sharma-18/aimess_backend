/**
 * Which authorization gate a direct room gets is decided by the ROOM, never by
 * the caller's claim.
 *
 * Room ids are server-minted with a kind prefix (`generateRoomId("grp"|"prv")`),
 * so the prefix is authoritative and a client cannot lie about it.
 *
 * Trusting `conversationType` off the wire was a real defect in both directions:
 * a client sending `conversationType: "private"` for a `grp_` room had its group
 * message run through the PRIVATE friendship gate and rejected with "You must be
 * friends to message this user"; the mirror case would let a private send skip
 * that gate by claiming "GROUP".
 *
 * Only an unprefixed (legacy) id falls back to the claim.
 */
export function resolveConversationType(
  roomId: string | null | undefined,
  claimed?: string | null
): "PRIVATE" | "GROUP" {
  const id = roomId ?? "";
  if (id.startsWith("grp_")) return "GROUP";
  if (id.startsWith("prv_")) return "PRIVATE";
  return String(claimed ?? "").toUpperCase() === "GROUP" ? "GROUP" : "PRIVATE";
}
