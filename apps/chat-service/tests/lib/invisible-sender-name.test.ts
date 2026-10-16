/**
 * A profile name made only of invisible characters (U+3164 Hangul filler,
 * U+2800 Braille blank, ZWSP) passes String.trim(). It used to be snapshotted
 * onto community messages as `senderName`, and clients rendered an empty name
 * row above the bubble. It must count as "no name" so the handle wins.
 */
import { resolveSenderIdentity } from "../../src/lib/resolve-sender-identity.js";
import {
  resolveDisplayName,
  resolveRealDisplayName,
} from "../../src/services/user-snapshot.service.js";
import type { UserSnapshotService } from "../../src/services/user-snapshot.service.js";
import type { CacheRepository } from "../../src/repositories/cache.repository.js";

const INVISIBLE = ["ㅤ", "⠀⠀", "​", " ㅤ "];

describe("invisible-only sender names", () => {
  it.each(INVISIBLE)("resolveDisplayName skips %j", (name) => {
    const snap = { fullName: name, displayName: name, username: "dhruv" };
    expect(resolveDisplayName(snap)).toBe("dhruv");
    expect(resolveRealDisplayName(snap)).toBe("dhruv");
  });

  it.each(INVISIBLE)("resolveSenderIdentity ignores a supplied %j", async (name) => {
    const snapshots = {
      getUserSnapshotsMap: async () =>
        new Map([["u1", { fullName: "Dhruv Vyas", avatar: "a.png" }]]),
    } as unknown as UserSnapshotService;
    const out = await resolveSenderIdentity(
      snapshots,
      {} as CacheRepository,
      "u1",
      name,
      "x.png"
    );
    expect(out.senderName).toBe("Dhruv Vyas");
  });
});
