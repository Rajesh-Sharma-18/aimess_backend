/**
 * Clears pnpm's workspace state when it is stuck in production-only mode
 * ("devDependencies: skipped", missing prettier/eslint, etc.), then runs `pnpm install`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = path.join(root, "node_modules", ".pnpm-workspace-state-v1.json");

try {
  fs.unlinkSync(state);
  process.stderr.write(
    "Removed node_modules/.pnpm-workspace-state-v1.json (was forcing production-style installs).\n"
  );
} catch {
  // ignore
}

const r = spawnSync("pnpm", ["install"], {
  stdio: "inherit",
  cwd: root,
  shell: process.platform === "win32",
});

process.exit(r.status === null ? 1 : r.status);
