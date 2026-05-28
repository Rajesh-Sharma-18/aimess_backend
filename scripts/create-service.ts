import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEMPLATE_DIR = join(ROOT, "tooling", "service-template");

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".example",
  ".gitignore",
]);

function usage(exitCode: number): never {
  console.error(`Create a new Express app under apps/ from tooling/service-template.

Usage:
  pnpm create-service -- <service-slug> [--skip-install]

  <service-slug>   kebab-case name (e.g. user-service, mail-service)
  --skip-install   do not run pnpm install at the repo root

Examples:
  pnpm create-service -- user-service
`);
  process.exit(exitCode);
}

function isValidSlug(slug: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug);
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function shouldTreatAsText(filePath: string): boolean {
  const base = filePath.split(/[/\\]/).pop() ?? "";
  if (base === ".env.example") return true;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  return TEXT_EXTENSIONS.has(ext);
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".turbo")
      continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

function applyTemplate(content: string, slug: string): string {
  const title = titleFromSlug(slug);
  return content
    .replaceAll("@aimess/service-template", `@aimess/${slug}`)
    .replaceAll("__SERVICE_SLUG__", slug)
    .replaceAll("__SERVICE_TITLE__", title);
}

function copyTemplate(destRoot: string, slug: string): number {
  const templateRoot = resolve(TEMPLATE_DIR);
  const files = listFilesRecursive(templateRoot);
  for (const src of files) {
    const rel = relative(templateRoot, resolve(src));
    if (rel.startsWith("..") || rel === "") {
      throw new Error(`Invalid template path (outside template root): ${src}`);
    }
    const dest = join(destRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (shouldTreatAsText(src)) {
      const text = readFileSync(src, "utf8");
      writeFileSync(dest, applyTemplate(text, slug), "utf8");
    } else {
      writeFileSync(dest, readFileSync(src));
    }
  }
  return files.length;
}

/** New apps get a `dev` script; the in-repo template omits it so `turbo run dev` does not boot it. */
function addDevScriptToNewApp(destRoot: string, slug: string): void {
  const pkgPath = join(destRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name: string;
    scripts: Record<string, string>;
  };
  pkg.name = `@aimess/${slug}`;
  pkg.scripts.dev =
    "tsx watch --include ./src --clear-screen=false src/server.ts";
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

function main(): void {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw.includes("-h") || raw.includes("--help")) {
    usage(raw.length === 0 ? 1 : 0);
  }

  const skipInstall = raw.includes("--skip-install");
  const slug = raw.find((a) => !a.startsWith("-") && a !== "--");

  if (!slug) {
    console.error("Missing <service-slug>.\n");
    usage(1);
  }

  if (!isValidSlug(slug)) {
    console.error(
      `Invalid service slug "${slug}". Use kebab-case (letters/numbers, single hyphens).\n`
    );
    process.exit(1);
  }

  if (slug === "service-template") {
    console.error(
      'Slug "service-template" is reserved (would collide with workspace package @aimess/service-template).\n'
    );
    process.exit(1);
  }

  if (!existsSync(TEMPLATE_DIR)) {
    console.error(`Template directory not found: ${TEMPLATE_DIR}`);
    process.exit(1);
  }

  const dest = join(ROOT, "apps", slug);
  if (existsSync(dest)) {
    console.error(`Target already exists: ${dest}`);
    process.exit(1);
  }

  mkdirSync(dest, { recursive: true });
  const fileCount = copyTemplate(dest, slug);
  addDevScriptToNewApp(dest, slug);

  console.log(
    `Created ${relative(ROOT, dest)} (${String(fileCount)} files from template)`
  );
  console.log(`Copy .env.example to .env inside that app, then run:`);
  console.log(`  pnpm --filter @aimess/${slug} dev`);

  if (!skipInstall) {
    console.log("\nRunning pnpm install at repo root…");
    try {
      // Use execSync so Windows resolves `pnpm` via PATH/shell; spawnSync on
      // `pnpm.cmd` often fails with EINVAL without a shell.
      execSync("pnpm install", {
        cwd: ROOT,
        stdio: "inherit",
        env: process.env,
      });
    } catch (err: unknown) {
      const status =
        err &&
        typeof err === "object" &&
        "status" in err &&
        typeof err.status === "number"
          ? err.status
          : 1;
      process.exit(status);
    }
  }
}

main();
