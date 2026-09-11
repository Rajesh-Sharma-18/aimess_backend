/**
 * Edge configuration guards (AIM-11, AIM-19, AIM-53, AIM-76, AIM-83).
 *
 * These all describe the same failure shape: a control that is present and
 * correct in code, switched off by configuration, with nothing refusing the
 * boot. The gateway is the only public edge, so each of them is load-bearing.
 *
 * `src/config/env.ts` parses `process.env` once at import and calls
 * `process.exit(1)` on a bad configuration, so every case here re-imports the
 * module inside `jest.isolateModulesAsync` with a patched environment and a
 * stubbed `process.exit`.
 */

type EnvPatch = Record<string, string | undefined>;

/**
 * Import a fresh copy of `src/config/env.ts` under `patch`, capturing whether
 * it tried to exit. `process.exit` is stubbed to throw so module evaluation
 * stops exactly where the real process would have died, instead of running on
 * with a half-built config.
 *
 * A patch value of `""` is how a case says "this variable is not configured".
 * Deleting the key does NOT work: `env.ts` calls `dotenv.config()`, which would
 * then refill it from the developer's real `.env` on disk and the case would
 * silently assert nothing.
 */
async function loadEnv(patch: EnvPatch): Promise<{
  exited: boolean;
  errors: string[];
  module?: typeof import("../../src/config/env.js");
}> {
  const original = { ...process.env };
  const errors: string[] = [];

  const exitSpy = jest.spyOn(process, "exit").mockImplementation(((): never => {
    throw new Error("__EXIT__");
  }) as never);
  const errorSpy = jest
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  let exited = false;
  let module: typeof import("../../src/config/env.js") | undefined;

  try {
    await jest.isolateModulesAsync(async () => {
      module = await import("../../src/config/env.js");
    });
  } catch (err) {
    if (err instanceof Error && err.message === "__EXIT__") exited = true;
    else throw err;
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    process.env = original;
  }

  return { exited, errors, module };
}

/** A configuration that should boot cleanly, so each case varies ONE thing. */
const VALID_PRODUCTION: EnvPatch = {
  NODE_ENV: "production",
  CORS_ALLOWED_ORIGINS: "https://app.example.com",
  CORS_ALLOW_ANY_ORIGIN: "false",
  RATE_LIMIT_ENABLED: "true",
  RATE_LIMIT_STORE: "redis",
  BACKOFFICE_SERVICE_URL: "http://backoffice:3010",
  JWT_ADMIN_SECRET: "test-admin-secret-do-not-use-in-prod",
  ADMIN_IP_WHITELIST: "203.0.113.10",
};

describe("gateway env — production boot assertions", () => {
  it("boots when every control is configured", async () => {
    const { exited } = await loadEnv(VALID_PRODUCTION);
    expect(exited).toBe(false);
  });

  it("refuses to start with the any-origin CORS bypass on (AIM-11)", async () => {
    const { exited, errors } = await loadEnv({
      ...VALID_PRODUCTION,
      CORS_ALLOW_ANY_ORIGIN: "true",
    });

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("CORS_ALLOW_ANY_ORIGIN");
  });

  it("refuses to start with an empty CORS allowlist (AIM-11)", async () => {
    const { exited, errors } = await loadEnv({
      ...VALID_PRODUCTION,
      CORS_ALLOWED_ORIGINS: "",
    });

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("CORS_ALLOWED_ORIGINS");
  });

  it("refuses an in-process rate-limit store in production (AIM-72)", async () => {
    // Per-process counters are wiped by every restart and multiply every limit
    // by the replica count — and the API's nginx config uses `ip_hash`, so a
    // client can choose which replica's counter it lands on.
    const { exited, errors } = await loadEnv({
      ...VALID_PRODUCTION,
      RATE_LIMIT_STORE: "memory",
    });

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("RATE_LIMIT_STORE");
  });

  it("refuses to start with rate limiting disabled (AIM-76)", async () => {
    const { exited, errors } = await loadEnv({
      ...VALID_PRODUCTION,
      RATE_LIMIT_ENABLED: "false",
    });

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("RATE_LIMIT_ENABLED");
  });

  it("refuses to mount the admin proxy without its token verifier (AIM-19)", async () => {
    const { exited, errors } = await loadEnv({
      ...VALID_PRODUCTION,
      JWT_ADMIN_SECRET: "",
    });

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("JWT_ADMIN_SECRET");
  });

  it("refuses an empty admin IP allowlist, which means allow-all (AIM-53)", async () => {
    const { exited, errors } = await loadEnv({
      ...VALID_PRODUCTION,
      ADMIN_IP_WHITELIST: "",
    });

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("ADMIN_IP_WHITELIST");
  });

  it("refuses an admin IP allowlist whose entries are ALL malformed", async () => {
    // The list is not empty, so the old length check passed it — but every
    // entry is rejected by the parser, which then returns "no restriction" and
    // opens the entire /admin surface. A misconfiguration must never be the
    // thing that removes the control.
    const { exited, errors } = await loadEnv({
      ...VALID_PRODUCTION,
      ADMIN_IP_WHITELIST: "203.0.113.0/33,not-an-ip",
    });

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("no usable entries");
  });

  it("boots when only SOME entries are malformed", async () => {
    // A surviving rule still enforces a perimeter; the bad entry is logged and
    // ignored, exactly as before.
    const { exited } = await loadEnv({
      ...VALID_PRODUCTION,
      ADMIN_IP_WHITELIST: "203.0.113.10,not-an-ip",
    });

    expect(exited).toBe(false);
  });

  it("refuses an explicit 0.0.0.0/0 admin allowlist", async () => {
    // Allow-all spelled out. Identical in effect to the empty list refused
    // above, so it is refused for the same reason rather than being obeyed
    // silently on the one perimeter where it cannot be intended.
    const { exited, errors } = await loadEnv({
      ...VALID_PRODUCTION,
      ADMIN_IP_WHITELIST: "0.0.0.0/0",
    });

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("matches every address");
  });

  it("accepts a CIDR admin allowlist", async () => {
    const { exited } = await loadEnv({
      ...VALID_PRODUCTION,
      ADMIN_IP_WHITELIST: "198.51.100.0/24,2001:db8::/32",
    });

    expect(exited).toBe(false);
  });

  it("applies none of these assertions outside production", async () => {
    // Local development must stay frictionless: the same configuration that is
    // refused above is fine when NODE_ENV is not production.
    const { exited } = await loadEnv({
      ...VALID_PRODUCTION,
      NODE_ENV: "development",
      CORS_ALLOW_ANY_ORIGIN: "true",
      RATE_LIMIT_ENABLED: "false",
      ADMIN_IP_WHITELIST: "0.0.0.0/0,garbage",
      JWT_ADMIN_SECRET: "",
    });

    expect(exited).toBe(false);
  });

  it("requires NODE_ENV to be set at all (AIM-83)", async () => {
    // It used to default to "development", which silently downgraded the edge.
    const { exited } = await loadEnv({
      ...VALID_PRODUCTION,
      NODE_ENV: "",
    });

    expect(exited).toBe(true);
  });

  it("rejects a short JWT_ACCESS_SECRET (AIM-84)", async () => {
    const { exited } = await loadEnv({
      ...VALID_PRODUCTION,
      JWT_ACCESS_SECRET: "x",
    });

    expect(exited).toBe(true);
  });

  it("requires the LiveKit webhook pair, with no fallback (AIM-36)", async () => {
    // The default used to be a key/secret published in this repository, so an
    // unset variable meant forged webhooks verified successfully.
    const { exited } = await loadEnv({
      ...VALID_PRODUCTION,
      LIVEKIT_API_SECRET: "",
    });

    expect(exited).toBe(true);
  });
});

describe("isCorsOriginAllowed", () => {
  it("admits only configured origins, whatever NODE_ENV says (AIM-11)", async () => {
    // The old implementation returned true for ANY origin unless NODE_ENV was
    // exactly "production" — including under "test", which is this suite.
    const { module } = await loadEnv({
      NODE_ENV: "test",
      CORS_ALLOWED_ORIGINS: "https://app.example.com",
      CORS_ALLOW_ANY_ORIGIN: "false",
    });

    expect(module?.isCorsOriginAllowed("https://app.example.com")).toBe(true);
    expect(module?.isCorsOriginAllowed("https://evil.example")).toBe(false);
    // No Origin header at all: native apps, curl, server-to-server.
    expect(module?.isCorsOriginAllowed(undefined)).toBe(true);
  });

  it("admits any origin only behind the explicit dev-tunnel flag", async () => {
    const { module } = await loadEnv({
      NODE_ENV: "development",
      CORS_ALLOWED_ORIGINS: "https://app.example.com",
      CORS_ALLOW_ANY_ORIGIN: "true",
    });

    expect(module?.isCorsOriginAllowed("https://whatever.ngrok.app")).toBe(
      true
    );
  });
});
