/**
 * The profile-status mirror repair (lib/profile-status-resync.ts).
 *
 * Pins the three properties an operator relies on when running it against a
 * real environment: a dry run never calls the write, `--apply` writes exactly
 * the mirrorable rows and is safe to repeat, and a partial failure is reported
 * as a failure rather than printed under a "RESYNCED" header.
 */
import { resyncProfileStatusMirror } from "../../src/lib/profile-status-resync.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

/** An in-memory UserIndex with keyset paging, plus a spy on the one write. */
function harness(
  rows: { userId: string; status: string }[],
  { failFor = [] as string[], missing = [] as string[] } = {}
) {
  const sorted = [...rows].sort((x, y) => x.userId.localeCompare(y.userId));
  const lines: string[] = [];
  const writes: [string, string][] = [];
  const mirror = new Map<string, string>();
  const deps = {
    findUserIndexPage: jest.fn(
      async ({
        cursor,
        take,
        statuses,
      }: {
        cursor: string | undefined;
        take: number;
        statuses: string[];
      }) =>
        sorted
          .filter((r) => statuses.includes(r.status))
          .filter((r) => cursor === undefined || r.userId > cursor)
          .slice(0, take)
    ),
    setProfileStatus: jest.fn(async (userId: string, status: string) => {
      if (failFor.includes(userId)) throw new Error("UNAVAILABLE");
      if (missing.includes(userId))
        return { ok: false, errorCode: "USER_NOT_FOUND" };
      writes.push([userId, status]);
      mirror.set(userId, status);
      return { ok: true, errorCode: "" };
    }),
    log: (l: string) => lines.push(l),
    logError: (l: string) => lines.push(l),
  };
  return { deps, lines, writes, mirror };
}

const ROWS = [
  { userId: A, status: "BANNED" },
  { userId: B, status: "ACTIVE" },
  { userId: C, status: "SUSPENDED" },
  { userId: "u_seed_32", status: "BANNED" },
];

describe("resyncProfileStatusMirror", () => {
  it("dry run reads every page but never calls the write", async () => {
    const h = harness(ROWS);

    const result = await resyncProfileStatusMirror(h.deps, {
      apply: false,
      batchSize: 2,
    });

    expect(h.deps.setProfileStatus).not.toHaveBeenCalled();
    expect(result).toEqual({
      counts: { ACTIVE: 1, SUSPENDED: 1, BANNED: 1 },
      skipped: 1,
      noProfile: 0,
      failed: 0,
    });
    expect(h.lines[0]).toBe("DRY RUN — would resync");
    expect(h.lines).toContain("Re-run with --apply to write.");
  });

  it("apply writes each mirrorable row once, skipping non-UUID ids", async () => {
    const h = harness(ROWS);

    const result = await resyncProfileStatusMirror(h.deps, {
      apply: true,
      batchSize: 2,
    });

    expect(h.writes).toEqual([
      [A, "BANNED"],
      [B, "ACTIVE"],
      [C, "SUSPENDED"],
    ]);
    expect(result.failed).toBe(0);
    expect(h.lines[0]).toBe("RESYNCED");
  });

  it("re-running apply converges on the same mirror (idempotent)", async () => {
    const h = harness(ROWS);

    await resyncProfileStatusMirror(h.deps, { apply: true });
    const first = new Map(h.mirror);
    await resyncProfileStatusMirror(h.deps, { apply: true });

    expect(h.mirror).toEqual(first);
    expect(h.mirror.size).toBe(3);
  });

  it("a partial failure is reported as incomplete, not RESYNCED", async () => {
    const h = harness(ROWS, { failFor: [B] });

    const result = await resyncProfileStatusMirror(h.deps, { apply: true });

    expect(result.failed).toBe(1);
    expect(h.writes).toEqual([
      [A, "BANNED"],
      [C, "SUSPENDED"],
    ]);
    expect(h.lines).not.toContain("RESYNCED");
    expect(h.lines).toContain("RESYNC INCOMPLETE — attempted");
    expect(h.lines).toContain("  1 failed — safe to re-run.");
  });

  it("an ok:false answer (no live profile) is not counted as resynced", async () => {
    // user-service answers USER_NOT_FOUND without throwing — for a profile
    // that was never created or is soft-deleted. Counting it as written would
    // overstate the repair.
    const h = harness(ROWS, { missing: [C] });

    const result = await resyncProfileStatusMirror(h.deps, { apply: true });

    expect(result).toEqual({
      counts: { ACTIVE: 1, SUSPENDED: 0, BANNED: 1 },
      skipped: 1,
      noProfile: 1,
      failed: 0,
    });
    expect(h.lines).toContain(
      "  1 not written (no live profile in user-service)"
    );
  });

  it("does not swallow a read failure", async () => {
    const h = harness(ROWS);
    h.deps.findUserIndexPage.mockRejectedValueOnce(new Error("db down"));

    await expect(
      resyncProfileStatusMirror(h.deps, { apply: true })
    ).rejects.toThrow("db down");
    expect(h.deps.setProfileStatus).not.toHaveBeenCalled();
  });
});
