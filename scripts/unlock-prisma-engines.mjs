// Windows refuses to rename a DLL that a running process has loaded, so any
// `prisma generate` — including the implicit one inside `prisma db push`, and
// the ones in `build` / `typecheck` — fails with EPERM while the dev stack is
// up. Renaming the loaded file aside IS permitted (the running process keeps
// its open handle), which clears the path for Prisma's rename-into-place.
//
// Imported by each service's prisma.config.ts, which the Prisma CLI loads
// before running any command. No-op off Windows.
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Does this CLI invocation actually write a new client?
 *
 * Moving the engine aside for a command that never regenerates (`migrate
 * status`, `db execute`, `db push --skip-generate`, `validate`, or any command
 * that then fails) leaves the service with NO engine file at all, and it cannot
 * start until the next successful generate. So the rename is limited to the
 * commands that are certain to write one back.
 */
function willGenerate(argv) {
  if (argv.includes("--skip-generate")) return false;
  if (argv.includes("generate")) return true;
  // `db push` and `migrate dev/deploy/reset` run generate as a final step.
  if (argv.includes("push") || argv.includes("migrate")) return true;
  return false;
}

/**
 * Clear the way for a `prisma generate` writing into `generatedDir`.
 *
 * Scoped to ONE service on purpose: renaming another service's engine would
 * leave that service with no engine until its own generate runs, so a restart
 * before then would fail to boot.
 */
export function unlockPrismaEngine(generatedDir) {
  if (process.platform !== "win32") return;

  let entries;
  try {
    entries = readdirSync(generatedDir);
  } catch {
    return; // nothing generated yet — first run has nothing to unlock
  }

  const engine = join(generatedDir, "query_engine-windows.dll.node");

  for (const name of entries) {
    const path = join(generatedDir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }

    // Orphaned temp copies and previously renamed engines: ~21MB each, and
    // they accumulate one per failed run. Deletable once nothing holds them.
    if (/^query_engine.*\.tmp\d+$/.test(name) || /\.old-\d+$/.test(name)) {
      try {
        rmSync(path);
      } catch {
        // still held by a running service; a later run collects it
      }
    }
  }

  if (!willGenerate(process.argv) || !existsSync(engine)) return;

  const parked = `${engine}.old-${Date.now()}`;
  try {
    renameSync(engine, parked);
  } catch {
    return; // not locked, or already gone — generate handles both
  }

  // If the generate never lands one back (it failed, or the command turned out
  // not to write one), put the original where the service expects to find it.
  // Without this a failed generate is the difference between "retry the
  // command" and "the service cannot boot".
  process.on("exit", () => {
    if (existsSync(engine)) return;
    try {
      renameSync(parked, engine);
    } catch {
      // nothing better to try at exit
    }
  });
}

// `node scripts/unlock-prisma-engines.mjs` sweeps stale copies for every
// service — housekeeping only, it never parks a live engine.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apps = join(dirname(fileURLToPath(import.meta.url)), "..", "apps");
  for (const app of readdirSync(apps)) {
    unlockPrismaEngine(join(apps, app, "src", "generated", "prisma"));
  }
}
