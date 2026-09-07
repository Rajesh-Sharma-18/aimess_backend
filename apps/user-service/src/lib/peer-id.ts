/**
 * Guard for user ids this service did NOT mint.
 *
 * `UserProfile.userId` is `@db.Uuid`, so a non-uuid string reaching a `where`
 * clause is not an empty match — it is a Postgres 22P02 (`invalid input syntax
 * for type uuid`), surfacing as Prisma `P2007` and failing the WHOLE request.
 *
 * chat-service stores `PrivateRoom.participants` as free-form strings, and rows
 * written before its own guards carry values that are not user ids at all
 * ("undefined", a `grp_` room id, a garbled uuid). Those ids reach user search
 * over gRPC, so they are filtered at that boundary — the same rule this
 * service's own gRPC server already applies to inbound ids.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUserId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Drop `{ peerUserId, roomId }` rows whose peer id is not a uuid. */
export function onlyUuidPeers<T extends { peerUserId: string }>(
  matches: readonly T[]
): T[] {
  return matches.filter((match) => isUserId(match.peerUserId));
}
