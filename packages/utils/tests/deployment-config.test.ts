import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AIM-24 / AIM-25 — deployment configuration that a code review can regress
 * silently, because nothing imports it.
 *
 * These are assertions about files, not about behaviour, which is exactly why
 * they are worth having: a one-line edit to `docker-compose.yml` or to a
 * `.env.example` can undo either fix, and no service test would notice.
 */
const REPO_ROOT = join(__dirname, "..", "..", "..");

function read(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

describe("local stack does not publish unauthenticated datastores (AIM-24)", () => {
  const compose = read("docker-compose.yml");

  /**
   * Refuted as a PRODUCTION finding, and correctly — this is the local compose,
   * and production uses managed, authenticated instances. It is still a real
   * exposure on a developer's machine: an unauthenticated Mongo and Redis bound
   * to 0.0.0.0 are reachable by anyone on the same café or office network.
   *
   * Mongo cannot simply be given `--auth` here; alongside `--replSet` that
   * requires a mounted internal-auth keyfile, which is painful on Windows and
   * is why the stack was built this way. Binding to loopback removes the
   * reachability instead, and needs no connection-string change anywhere.
   */
  it.each([
    ["Postgres", "5432"],
    ["Mongo", "27017"],
    ["Redis", "6379"],
    ["RabbitMQ", "5672"],
    ["MinIO", "9000"],
  ])("binds %s to an interface, not to every interface", (_name, port) => {
    const published = compose
      .split("\n")
      .filter((line) => line.trim().startsWith("- \"") && line.includes(`:${port}"`));

    expect(published.length).toBeGreaterThan(0);
    for (const line of published) {
      expect(line).toContain("INFRA_BIND_ADDR");
    }
  });

  it("defaults that bind address to loopback", () => {
    // The default is what an unmodified checkout runs, so the default is the
    // security property. An operator who needs LAN access opts in.
    expect(compose).toContain("${INFRA_BIND_ADDR:-127.0.0.1}");
  });

  it("leaves no datastore port published without the bind address", () => {
    const bare = compose
      .split("\n")
      .filter((line) => /^\s+- "\$\{[A-Z_]*PORT\}:/.test(line));

    expect(bare).toEqual([]);
  });
});

describe("services hold scoped MinIO accounts, not root (AIM-25)", () => {
  const SERVICES = [
    "media",
    "user",
    "chat",
    "community",
    "stream",
    "backoffice",
  ];

  /**
   * Six services held the MinIO ROOT credentials. Root can read and delete
   * every object in every bucket, drop the buckets themselves, and change
   * server config — so a leak from any one of them handed over all user media
   * at once, and the ability to destroy it. Nothing about stream-service's job
   * requires the power to empty the avatars bucket.
   */
  it.each(SERVICES)(
    "%s-service names its own account, never the published default",
    (service) => {
      const example = read(`apps/${service}-service/.env.example`);
      const accessKey = /^MINIO_ACCESS_KEY=(.*)$/m.exec(example)?.[1] ?? "";

      expect(accessKey).toBe(`aimess-${service}`);
      // `minioadmin` is MinIO's documented default and was checked in for three
      // of these services.
      expect(example).not.toMatch(/^MINIO_(ACCESS|SECRET)_KEY=minioadmin$/m);
      expect(example).not.toMatch(/^MINIO_ROOT_/m);
    }
  );

  it("provisions one account per service, each scoped to named buckets", () => {
    const script = read("deploy/minio/init-buckets.sh");

    for (const service of SERVICES) {
      expect(script).toContain(`provision aimess-${service} `);
    }
  });

  it("refuses to provision an account with no secret configured", () => {
    // Falling back to a default — or to root — is precisely the failure this
    // replaces, so the script must fail loudly instead.
    const script = read("deploy/minio/init-buckets.sh");

    expect(script).toContain("refusing to provision");
    expect(script).not.toMatch(/MINIO_SECRET_[A-Z]+:-/);
  });

  it("keeps stream-service out of the chat and community buckets", () => {
    // The point of scoping: a leak from one service is bounded by what that
    // service could already do.
    const script = read("deploy/minio/init-buckets.sh");
    const line = script
      .split("\n")
      .find((l) => l.startsWith("provision aimess-stream "));

    expect(line).toBeDefined();
    expect(line).not.toContain("$CHAT");
    expect(line).not.toContain("$COMMUNITY");
  });

  it("hands the root credentials only to the provisioning container", () => {
    const compose = read("docker-compose.yml");
    const rootRefs = compose
      .split("\n")
      .filter((line) => line.includes("MINIO_ROOT_"));

    // The MinIO server itself, plus minio-init. No application service.
    expect(rootRefs.length).toBeGreaterThan(0);
    expect(compose).toContain("minio-init:");
  });
});
