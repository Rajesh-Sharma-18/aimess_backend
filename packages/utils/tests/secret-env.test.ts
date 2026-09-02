/**
 * AIM-20 / AIM-21 / AIM-22 / AIM-25 / AIM-56 / AIM-57 — secrets come from
 * files, not environment variables.
 *
 * Every secret the platform holds was readable only from a plaintext env var,
 * which put it in a `.env` on the host, in the image, and in the process
 * environment — where `/proc/<pid>/environ`, a crash dump, `docker inspect` or
 * a CI job that echoes the environment discloses it. Rotation meant editing
 * that file on every host, so it did not happen.
 *
 * `FOO_FILE` is what Docker secrets and Kubernetes secret volumes already
 * provide, and it makes rotation "replace the file".
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNoPlaceholderCredentials,
  assertNoPlaceholderSecrets,
  expandFileSecrets,
  isPlaceholderSecret,
} from "../src/secret-env.js";

const dir = mkdtempSync(join(tmpdir(), "aimess-secret-env-"));

function secretFile(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("expandFileSecrets", () => {
  it("resolves FOO_FILE into FOO", () => {
    const path = secretFile("token", "s3cr3t-value");

    const env = expandFileSecrets({ GRPC_SERVICE_TOKEN_FILE: path });

    expect(env.GRPC_SERVICE_TOKEN).toBe("s3cr3t-value");
  });

  it("strips only the trailing newline an editor leaves behind", () => {
    const path = secretFile("trailing", "value-with-newline\n");
    expect(expandFileSecrets({ X_FILE: path }).X).toBe("value-with-newline");
  });

  it("preserves the interior newlines of a PEM key", () => {
    // Trimming these would corrupt the key and produce a signature failure that
    // is very hard to trace back to secret loading.
    const pem =
      "-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\n";
    const path = secretFile("key.pem", pem);

    expect(
      expandFileSecrets({ JWT_ACCESS_PRIVATE_KEY_FILE: path })
        .JWT_ACCESS_PRIVATE_KEY
    ).toBe(pem.replace(/\n$/, ""));
  });

  it("lets an explicit value win over the file", () => {
    const path = secretFile("override", "from-file");

    const env = expandFileSecrets({ X_FILE: path, X: "from-env" });

    expect(env.X).toBe("from-env");
  });

  it("refuses to start when the file cannot be read", () => {
    // Falling through to an unset variable is how a service ends up running
    // with no credential at all — the failure this is meant to prevent.
    expect(() =>
      expandFileSecrets({ X_FILE: join(dir, "does-not-exist") })
    ).toThrow(/could not be read/);
  });

  it("ignores an empty _FILE pointer rather than failing", () => {
    // An unset variable in a compose file renders as empty; that means "not
    // configured", not "configured wrongly".
    expect(() => expandFileSecrets({ X_FILE: "" })).not.toThrow();
    expect(expandFileSecrets({ X_FILE: "  " }).X).toBeUndefined();
  });

  it("leaves plain variables untouched, so nothing changes for an old deployment", () => {
    const env = expandFileSecrets({ PLAIN: "value", OTHER: "second" });
    expect(env.PLAIN).toBe("value");
    expect(env.OTHER).toBe("second");
  });

  it("does not mutate the source environment", () => {
    const path = secretFile("nomutate", "v");
    const source = { X_FILE: path };

    expandFileSecrets(source);

    expect((source as Record<string, unknown>).X).toBeUndefined();
  });
});

describe("isPlaceholderSecret", () => {
  it.each([
    "dev-grpc-service-token-change-me",
    "devkey",
    "devsecretchangeme_at_least_32_chars_long",
    "dev_admin_access_secret_change_me_0001",
    "changeme",
    "minioadmin",
    "your-secret-here",
    "<replace>",
    "xxxxxxxx",
  ])("recognises %s as published, not secret", (value) => {
    expect(isPlaceholderSecret(value)).toBe(true);
  });

  it("recognises them regardless of case or padding", () => {
    expect(isPlaceholderSecret("  DevKey  ")).toBe(true);
  });

  it("accepts a real generated value", () => {
    expect(
      isPlaceholderSecret("Zk9s3Qk1r7Yb2mVx8Tn4Lp6Wc0Jd5Hg2Aq7Ue1Ri3Bo")
    ).toBe(false);
  });

  it("treats unset and empty as 'not configured', not 'placeholder'", () => {
    // The schema reports those; a duplicate complaint here would be noise.
    expect(isPlaceholderSecret(undefined)).toBe(false);
    expect(isPlaceholderSecret("")).toBe(false);
  });
});

describe("assertNoPlaceholderSecrets", () => {
  it("refuses a production boot and names every offender at once", () => {
    expect(() =>
      assertNoPlaceholderSecrets(
        {
          GRPC_SERVICE_TOKEN: "dev-grpc-service-token-change-me",
          LIVEKIT_API_KEY: "devkey",
          JWT_ACCESS_SECRET: "a-real-and-sufficiently-long-secret-value",
        },
        { nodeEnv: "production", serviceName: "chat-service" }
      )
    ).toThrow(/GRPC_SERVICE_TOKEN, LIVEKIT_API_KEY/);
  });

  it("says nothing when every value is real", () => {
    expect(() =>
      assertNoPlaceholderSecrets(
        { A: "Zk9s3Qk1r7Yb2mVx8Tn4Lp6Wc0Jd5Hg2Aq7Ue1Ri3Bo" },
        { nodeEnv: "production", serviceName: "chat-service" }
      )
    ).not.toThrow();
  });

  it("stays out of the way outside production", () => {
    // Local development runs on the committed templates by design.
    expect(() =>
      assertNoPlaceholderSecrets(
        { GRPC_SERVICE_TOKEN: "dev-grpc-service-token-change-me" },
        { nodeEnv: "development", serviceName: "chat-service" }
      )
    ).not.toThrow();
  });
});

/**
 * AIM-25 and friends. `assertNoPlaceholderSecrets` was written, exported and
 * tested — and called by nothing, so no service actually refused to boot on a
 * published value. It also required the caller to enumerate what to check,
 * which is how `MINIO_ACCESS_KEY=minioadmin` stayed in three services'
 * templates while the JWT secrets were being taken seriously.
 *
 * This variant walks the environment and matches on the variable NAME, so a
 * credential added tomorrow is covered with nothing to remember.
 */
describe("assertNoPlaceholderCredentials", () => {
  const opts = { nodeEnv: "production", serviceName: "media-service" };

  it("refuses to boot on MinIO's published default credentials", () => {
    expect(() =>
      assertNoPlaceholderCredentials(
        { MINIO_ACCESS_KEY: "minioadmin", MINIO_SECRET_KEY: "minioadmin" },
        opts
      )
    ).toThrow(/MINIO_ACCESS_KEY/);
  });

  it("names every offender at once, not one per restart", () => {
    expect(() =>
      assertNoPlaceholderCredentials(
        {
          MINIO_SECRET_KEY: "minioadmin",
          GRPC_SERVICE_TOKEN: "dev-grpc-service-token-change-me",
          SMTP_PASSWORD: "changeme",
        },
        opts
      )
    ).toThrow(/MINIO_SECRET_KEY.*GRPC_SERVICE_TOKEN.*SMTP_PASSWORD/s);
  });

  it.each([
    "JWT_ACCESS_SECRET",
    "MONGO_PASSWORD",
    "GRPC_SERVICE_TOKEN",
    "FIREBASE_PRIVATE_KEY",
    "SOME_NEW_APIKEY",
    "VENDOR_CREDENTIAL",
  ])("covers %s by name shape", (name) => {
    expect(() =>
      assertNoPlaceholderCredentials({ [name]: "changeme" }, opts)
    ).toThrow(new RegExp(name));
  });

  it("ignores variables that carry no credential", () => {
    // A bucket called "secret" would be a silly reason to refuse a deploy, but
    // a bucket NAME is not credential-shaped, so it is never examined.
    expect(() =>
      assertNoPlaceholderCredentials(
        { MINIO_BUCKET: "changeme", NODE_ENV: "production" },
        opts
      )
    ).not.toThrow();
  });

  it("accepts real generated values", () => {
    expect(() =>
      assertNoPlaceholderCredentials(
        {
          MINIO_ACCESS_KEY: "aimess-media",
          MINIO_SECRET_KEY: "Zk9s3Qk1r7Yb2mVx8Tn4Lp6Wc0Jd5Hg2Aq7Ue1Ri3Bo",
        },
        opts
      )
    ).not.toThrow();
  });

  it("stays out of the way outside production", () => {
    // Local development runs on the compose defaults by design; blocking that
    // would just teach everyone to unset NODE_ENV.
    expect(() =>
      assertNoPlaceholderCredentials(
        { MINIO_SECRET_KEY: "minioadmin" },
        { nodeEnv: "development", serviceName: "media-service" }
      )
    ).not.toThrow();
  });
});
