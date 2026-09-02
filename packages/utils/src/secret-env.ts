import { readFileSync } from "node:fs";

/**
 * File-backed secrets: `FOO_FILE=/run/secrets/foo` supplies `FOO`.
 *
 * Every secret this platform holds — the Firebase service-account key, the APNs
 * signing key, the SMTP password, the MinIO credentials, the database
 * passwords, the JWT keys — was readable only from a plaintext environment
 * variable, which meant:
 *
 *  - the value sat in a `.env` file on the host, in the image, and in the
 *    process environment, where `/proc/<pid>/environ`, a crash dump, a
 *    `docker inspect`, or a CI log that echoes the environment discloses it;
 *  - rotation was a manual edit of that file on every host, so it was skipped;
 *  - and a leak could not be contained without a redeploy.
 *
 * Reading from a file instead is what Docker secrets, Kubernetes secret volumes
 * and every managed secret store already provide: the value is a
 * root-readable, mode-0400 file that never enters the environment, and
 * rotation is replacing the file. This helper is the one line each service
 * needs to accept that shape.
 *
 * Deliberately additive: a plain `FOO` still works, so nothing changes for a
 * deployment that has not moved yet, and both forms can coexist during a
 * migration.
 */

/** Longest secret we will read from a file. Guards against a wrong path. */
const MAX_SECRET_BYTES = 1024 * 64;

/**
 * Return a copy of `source` where every `X_FILE` entry has been resolved into
 * `X` by reading that file.
 *
 * An explicit `X` always wins, so a deployment can override a mounted secret
 * without unmounting it. A `X_FILE` that cannot be read is fatal: continuing
 * would fall through to whatever `X` happens to hold (often nothing), and a
 * service silently starting with no credential is precisely the failure this
 * is meant to prevent.
 */
export function expandFileSecrets(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...source };

  for (const [key, value] of Object.entries(source)) {
    if (!key.endsWith("_FILE")) continue;
    if (value === undefined || value.trim() === "") continue;

    const target = key.slice(0, -"_FILE".length);
    if (target.length === 0) continue;
    // An explicit value takes precedence — see above.
    if (resolved[target] !== undefined && resolved[target] !== "") continue;

    let contents: string;
    try {
      contents = readFileSync(value, { encoding: "utf8" });
    } catch (err) {
      throw new Error(
        `${key} points at ${value}, which could not be read: ${
          err instanceof Error ? err.message : String(err)
        }. Refusing to start with an unresolved secret.`,
        // Keep the original so the operator sees ENOENT vs EACCES vs EISDIR —
        // "could not be read" alone does not say whether the file is missing or
        // the container cannot see it, which are different fixes.
        { cause: err }
      );
    }

    if (contents.length > MAX_SECRET_BYTES) {
      throw new Error(
        `${key} points at ${value}, which is larger than ${String(
          MAX_SECRET_BYTES
        )} bytes. That is not a secret file — check the path.`
      );
    }

    // Trim only the trailing newline an editor or `echo` leaves behind. Leading
    // and interior whitespace is preserved: PEM blocks and JSON keys contain
    // both, and silently altering a key produces a signature failure that is
    // very hard to trace back to here.
    resolved[target] = contents.replace(/\r?\n$/, "");
  }

  return resolved;
}

/**
 * Values that have appeared in this repository's committed templates, or that
 * are obviously placeholders. A production deployment using one of them holds
 * no secret at all — the value is public.
 *
 * Checked at boot alongside the schema, because a schema can only see that a
 * string is present and long enough; it cannot see that everyone already knows
 * what it says.
 */
const PUBLISHED_PLACEHOLDERS = new Set(
  [
    "dev-grpc-service-token-change-me",
    "devkey",
    "devsecretchangeme_at_least_32_chars_long",
    "dev_admin_access_secret_change_me_0001",
    "changeme",
    "change-me",
    "change_me",
    "secret",
    "password",
    "minioadmin",
    "your-secret-here",
    "replace-me",
  ].map((value) => value.toLowerCase())
);

/** True when a configured secret is a known placeholder rather than a secret. */
export function isPlaceholderSecret(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (PUBLISHED_PLACEHOLDERS.has(normalized)) return true;
  // `your-*` / `<...>` / `xxx...` template shapes.
  if (/^your[-_]/.test(normalized)) return true;
  if (/^<.*>$/.test(normalized)) return true;
  if (/^x{6,}$/.test(normalized)) return true;
  return false;
}

/**
 * Refuse to start a production service whose secrets are placeholders.
 *
 * `entries` maps a variable name to its configured value. Anything recognised
 * is reported together, so an operator fixes one list rather than discovering
 * them one restart at a time.
 */
export function assertNoPlaceholderSecrets(
  entries: Record<string, string | undefined>,
  options: { nodeEnv: string; serviceName: string }
): void {
  if (options.nodeEnv !== "production") return;

  const offenders = Object.entries(entries)
    .filter(([, value]) => isPlaceholderSecret(value))
    .map(([name]) => name);

  if (offenders.length === 0) return;

  throw new Error(
    `${options.serviceName}: refusing to start — these are set to values published in this repository, so they are not secret: ${offenders.join(
      ", "
    )}. Generate real per-environment values (openssl rand -base64 32).`
  );
}

/**
 * Variable names that carry credentials, matched by shape rather than listed.
 *
 * A hand-maintained list per service is a list that goes stale: the guard would
 * silently stop covering the next secret anybody adds. Matching on the name
 * means a new `*_SECRET` / `*_PASSWORD` / `*_TOKEN` / `*_KEY` is covered the day
 * it is introduced, with nothing to remember.
 */
const CREDENTIAL_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|_KEY|APIKEY)/;

/**
 * Boot guard: refuse to start a production service holding a published
 * placeholder in ANY credential-shaped variable.
 *
 * The narrower `assertNoPlaceholderSecrets` needs the caller to enumerate what
 * to check. This walks the environment instead, so a service cannot be
 * protected for the secrets someone remembered and unprotected for the rest —
 * which is how `MINIO_ACCESS_KEY=minioadmin` survived in three services'
 * templates while the JWT secrets were being taken seriously.
 */
export function assertNoPlaceholderCredentials(
  source: NodeJS.ProcessEnv,
  options: { nodeEnv: string; serviceName: string }
): void {
  const entries: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    if (CREDENTIAL_NAME.test(name)) entries[name] = value;
  }

  assertNoPlaceholderSecrets(entries, options);
}
