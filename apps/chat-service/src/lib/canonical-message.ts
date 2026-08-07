/**
 * ONE message field vocabulary across private, group AND community.
 *
 * The community timeline serializes a `GeneralRoomMessage` row by spreading its
 * columns, so its wire inherited the DB's own names — `sentBy`, `message`,
 * `deletedForAll` — while private/group emit `senderId`, `content.text`,
 * `isDeleted`. Same concept, three different keys, forcing every client to carry
 * a per-conversation-type branch.
 *
 * This ADDS the canonical names alongside the community aliases, so a client can
 * parse all three surfaces with one model. The aliases are deliberately KEPT:
 * existing community clients read `sentBy`/`message`/`deletedForAll` and removing
 * them would be a breaking response change. Callers that only want the canonical
 * vocabulary simply ignore the aliases.
 */

const ALIASES: ReadonlyArray<readonly [alias: string, canonical: string]> = [
  ["sentBy", "senderId"],
  ["deletedForAll", "isDeleted"],
];

export function toCanonicalMessage<T>(wire: T): T {
  const m = wire as unknown as Record<string, unknown>;

  for (const [alias, canonical] of ALIASES) {
    if (!(alias in m)) continue;
    if (m[canonical] == null || m[canonical] === "") m[canonical] = m[alias];
  }

  // Flat `message` → `content.text`. Community stores the body as a bare column;
  // private/group nest it. Never clobber an existing content.text.
  if ("message" in m) {
    const text = m.message;
    const content = (m.content ?? {}) as Record<string, unknown>;
    if (content.text == null || content.text === "") content.text = text ?? "";
    m.content = content;
  }

  return wire;
}

export function toCanonicalMessages<T>(wires: T[]): T[] {
  for (const w of wires) toCanonicalMessage(w);
  return wires;
}
