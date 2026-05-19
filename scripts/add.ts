import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const isDev = args.includes("--dev");
const positional = args.filter((a) => a !== "--dev");

const [pkg, target] = positional;

if (!pkg || !target) {
  console.error(
    "Usage: pnpm run add -- <npm-package> <workspace> [--dev]\n" +
      "  <workspace>: api-gateway | auth-service | shared-types | redis | logger | constants | errors | utils | root\n" +
      "  root = install on workspace root (-w)\n" +
      "Example: pnpm run add -- express api-gateway\n" +
      "Example: pnpm run add -- @aimess/errors api-gateway --dev"
  );
  process.exit(1);
}

const pnpmArgs = ["add", ...(isDev ? ["-D"] : []), pkg];

if (target === "root" || target === ".") {
  pnpmArgs.push("-w");
} else {
  const workspace = target.startsWith("@aimess/")
    ? target
    : `@aimess/${target}`;
  pnpmArgs.push("--filter", workspace);
}

console.log(`Running: pnpm ${pnpmArgs.join(" ")}`);

const result = spawnSync("pnpm", pnpmArgs, {
  stdio: "inherit",
  // Windows: `pnpm` is usually a .cmd shim; spawn without shell often fails (ENOENT).
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
