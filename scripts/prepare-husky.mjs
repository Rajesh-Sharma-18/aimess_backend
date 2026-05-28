/**
 * Runs Husky when present (dev install). Skips in CI / HUSKY=0 or when husky is not installed
 * (e.g. after a production-only install). Uses `node …/bin.js` so Windows does not rely on
 * a global `husky` on PATH.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.env.CI === "true" || process.env.HUSKY === "0") {
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const huskyBin = path.join(root, "node_modules", "husky", "bin.js");

if (!existsSync(huskyBin)) {
  process.exit(0);
}

const result = spawnSync(process.execPath, [huskyBin], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
