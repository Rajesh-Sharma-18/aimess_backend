/**
 * Run `prisma format` for each workspace that ships a Prisma schema.
 * Invoked from `pnpm format` after Prettier.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const filters = ["@aimess/auth-service", "@aimess/user-service"];

for (const filter of filters) {
  const r = spawnSync(
    "pnpm",
    ["--filter", filter, "exec", "prisma", "format"],
    {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    }
  );
  if (r.status !== 0) {
    process.exit(r.status === null ? 1 : r.status);
  }
}
