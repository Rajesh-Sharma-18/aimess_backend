/**
 * ONE message field vocabulary for V2, across private, group AND community.
 *
 * The community timeline serializes a `GeneralRoomMessage` row by spreading its
 * columns, so its wire inherited the DB's own names — `sentBy`, `message`,
 * `deletedForAll` — while private/group emit `senderId`, `content.text`,
 * `isDeleted`. Same concept, three different keys, forcing every client to carry
 * a per-conversation-type branch.
 *
 * This maps the community aliases onto the canonical names and DELETES them, so a
 * V2 client parses all three surfaces with one model. V1 responses never pass
 * through here and keep their original shape.
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
    delete m[alias];
  }

  // Flat `message` → `content.text`. Community stores the body as a bare column;
  // private/group nest it. Never clobber an existing content.text.
  if ("message" in m) {
    const text = m.message;
    const content = (m.content ?? {}) as Record<string, unknown>;
    if (content.text == null || content.text === "") content.text = text ?? "";
    m.content = content;
    delete m.message;
  }

  return wire;
}

export function toCanonicalMessages<T>(wires: T[]): T[] {
  for (const w of wires) toCanonicalMessage(w);
  return wires;
}
