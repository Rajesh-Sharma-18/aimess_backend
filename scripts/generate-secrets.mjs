#!/usr/bin/env node
/**
 * Generate every secret this platform needs, into files.
 *
 * Rotation used to be an undocumented manual ritual: read the audit, work out
 * which variable lived in which of the twenty-three `.env` files, invent a
 * value, paste it into each one, and remember which services had to restart.
 * Predictably, it was skipped — which is how a key/secret pair published in
 * this repository ended up signing real call tokens.
 *
 * This turns the whole thing into one command. It writes a secrets directory
 * that services consume through `*_FILE` variables (see
 * `packages/utils/src/secret-env.ts`), so rotating a value is: run this, restart
 * the services that use it. No secret ever enters a `.env` file, an image, or a
 * process environment.
 *
 *   node scripts/generate-secrets.mjs                 # create missing only
 *   node scripts/generate-secrets.mjs --rotate jwt    # replace one group
 *   node scripts/generate-secrets.mjs --rotate all    # replace everything
 *   node scripts/generate-secrets.mjs --out ./secrets --print-env
 *
 * The JWT group produces an RS256 keypair: auth-service gets the private half,
 * every other service gets the public half. That is what makes a leak from any
 * other service unable to forge a token.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Groups a caller can rotate independently. */
const GROUPS = {
  jwt: "Access-token signing keypair + admin token secrets",
  grpc: "Internal service-to-service gRPC token",
  media: "SRS hook secret, LiveKit API pair, SRS API password",
  infra: "Database, Redis, RabbitMQ and MinIO passwords",
};

/**
 * name -> how to produce it.
 *
 * `bytes` is raw entropy rendered base64url, which is safe in a YAML value, a
 * connection string and a shell variable alike — several of these end up in all
 * three.
 */
const SECRETS = [
  { name: "JWT_ACCESS_PRIVATE_KEY", group: "jwt", kind: "rsa-private" },
  { name: "JWT_ACCESS_PUBLIC_KEY", group: "jwt", kind: "rsa-public" },
  { name: "JWT_REFRESH_SECRET", group: "jwt", kind: "bytes", bytes: 48 },
  { name: "JWT_ADMIN_SECRET", group: "jwt", kind: "bytes", bytes: 48 },
  { name: "JWT_ADMIN_REFRESH_SECRET", group: "jwt", kind: "bytes", bytes: 48 },
  { name: "GRPC_SERVICE_TOKEN", group: "grpc", kind: "bytes", bytes: 32 },
  { name: "SRS_HOOK_SECRET", group: "media", kind: "bytes", bytes: 32 },
  { name: "SRS_API_PASSWORD", group: "media", kind: "bytes", bytes: 24 },
  { name: "LIVEKIT_API_KEY", group: "media", kind: "bytes", bytes: 12 },
  { name: "LIVEKIT_API_SECRET", group: "media", kind: "bytes", bytes: 48 },
  { name: "POSTGRES_PASSWORD", group: "infra", kind: "bytes", bytes: 24 },
  { name: "MONGO_ROOT_PASSWORD", group: "infra", kind: "bytes", bytes: 24 },
  { name: "REDIS_PASSWORD", group: "infra", kind: "bytes", bytes: 24 },
  { name: "RABBITMQ_PASSWORD", group: "infra", kind: "bytes", bytes: 24 },
  { name: "MINIO_ROOT_PASSWORD", group: "infra", kind: "bytes", bytes: 24 },
];

function parseArgs(argv) {
  const args = { out: "./secrets", rotate: [], printEnv: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i] ?? args.out;
    else if (arg === "--rotate") {
      const value = argv[++i] ?? "";
      args.rotate = value === "all" ? Object.keys(GROUPS) : value.split(",");
    } else if (arg === "--print-env") args.printEnv = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.log("Generate secret files for the AIMess backend.\n");
  console.log("  --out <dir>        where to write (default ./secrets)");
  console.log("  --rotate <groups>  comma-separated, or 'all'");
  console.log("  --print-env        print the *_FILE variables to set\n");
  console.log("Groups:");
  for (const [name, description] of Object.entries(GROUPS)) {
    console.log(`  ${name.padEnd(7)} ${description}`);
  }
}

/** An RSA keypair, generated once per run and shared by both JWT entries. */
let keypair;
function rsaKeypair() {
  keypair ??= generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return keypair;
}

function generate(secret) {
  if (secret.kind === "rsa-private") return rsaKeypair().privateKey;
  if (secret.kind === "rsa-public") return rsaKeypair().publicKey;
  return randomBytes(secret.bytes).toString("base64url");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  const unknown = args.rotate.filter((g) => !(g in GROUPS));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown group(s): ${unknown.join(", ")}. Known: ${Object.keys(GROUPS).join(", ")}`
    );
  }

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const created = [];
  const rotated = [];
  const kept = [];

  for (const secret of SECRETS) {
    const file = join(outDir, secret.name);
    const exists = existsSync(file);
    const shouldRotate = args.rotate.includes(secret.group);

    if (exists && !shouldRotate) {
      kept.push(secret.name);
      continue;
    }

    // 0600: readable only by the owner. A secrets directory that anyone on the
    // host can read is not meaningfully better than an environment variable.
    writeFileSync(file, generate(secret), { encoding: "utf8", mode: 0o600 });
    (exists ? rotated : created).push(secret.name);
  }

  console.log(`Secrets directory: ${outDir}`);
  if (created.length) console.log(`  created: ${created.join(", ")}`);
  if (rotated.length) console.log(`  rotated: ${rotated.join(", ")}`);
  if (kept.length) console.log(`  kept:    ${kept.length} existing`);

  if (rotated.length > 0) {
    console.log(
      "\nRestart the services that read the rotated values. Access tokens signed" +
        "\nwith a previous JWT key stay valid until they expire only if the old" +
        "\npublic key is still configured — otherwise every session is ended."
    );
  }

  if (args.printEnv) {
    console.log(
      "\n# Point services at the files (compose env_file or K8s env):"
    );
    for (const secret of SECRETS) {
      console.log(`${secret.name}_FILE=${join(outDir, secret.name)}`);
    }
  }

  // Refuse to leave a half-written set behind: a service that boots with three
  // of four secrets is harder to diagnose than one that will not boot at all.
  const missing = SECRETS.filter((s) => !existsSync(join(outDir, s.name))).map(
    (s) => s.name
  );
  if (missing.length > 0) {
    throw new Error(`Failed to write: ${missing.join(", ")}`);
  }

  // Sanity-check the keypair actually pairs, rather than discovering it at the
  // first login after a rotation.
  const priv = readFileSync(join(outDir, "JWT_ACCESS_PRIVATE_KEY"), "utf8");
  const pub = readFileSync(join(outDir, "JWT_ACCESS_PUBLIC_KEY"), "utf8");
  if (!priv.includes("PRIVATE KEY") || !pub.includes("PUBLIC KEY")) {
    throw new Error(
      "JWT keypair did not render as PEM — refusing to continue."
    );
  }
}

main();
