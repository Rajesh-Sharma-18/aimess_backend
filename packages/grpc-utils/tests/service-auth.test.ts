/**
 * Self-check for `withServiceAuth` — the internal gRPC service-token gate.
 *
 * Deliberately plain `assert` run through tsx rather than a jest project: this
 * package has no other suite, and the whole branch matrix of one security gate
 * does not justify a jest config, preset and transform chain.
 *
 *   pnpm --filter @aimess/grpc-utils test
 */
import assert from "node:assert/strict";
import * as grpc from "@grpc/grpc-js";

import { withServiceAuth } from "../src/index.js";

const TOKEN = "correct-horse-battery-staple";
const METADATA_KEY = "x-aimess-service-token";

/** Build a fake unary `call` carrying `token` (omit for no metadata at all). */
function fakeCall(token?: string) {
  const metadata = new grpc.Metadata();
  if (token !== undefined) metadata.set(METADATA_KEY, token);
  return { metadata };
}

function makeImpl(onCall: () => void): grpc.UntypedServiceImplementation {
  return {
    ping: ((_call: unknown, callback: (e: unknown, r?: unknown) => void) => {
      onCall();
      callback(null, { ok: true });
    }) as unknown as grpc.UntypedHandleCall,
  };
}

// ── 1. Token set + correct token presented → handler runs ───────────────────
{
  process.env.GRPC_SERVICE_TOKEN = TOKEN;
  let ran = false;
  const guarded = withServiceAuth(
    "test",
    makeImpl(() => (ran = true))
  );
  let err: { code?: number } | null = null;
  (
    guarded as unknown as Record<
      string,
      (c: unknown, cb: (e: unknown) => void) => void
    >
  ).ping({ ...fakeCall(TOKEN), emit: () => undefined }, (e) => {
    err = e as { code?: number } | null;
  });
  assert.equal(ran, true, "valid token must reach the handler");
  assert.equal(err, null, "valid token must not produce an error");
}

// ── 2. Token set + WRONG token → UNAUTHENTICATED, handler never runs ────────
{
  process.env.GRPC_SERVICE_TOKEN = TOKEN;
  let ran = false;
  const guarded = withServiceAuth(
    "test",
    makeImpl(() => (ran = true))
  );
  let err: { code?: number } | null = null;
  (
    guarded as unknown as Record<
      string,
      (c: unknown, cb: (e: unknown) => void) => void
    >
  ).ping({ ...fakeCall("wrong-token"), emit: () => undefined }, (e) => {
    err = e as { code?: number } | null;
  });
  assert.equal(ran, false, "wrong token must NOT reach the handler");
  assert.equal(err?.code, grpc.status.UNAUTHENTICATED);
}

// ── 3. Token set + NO metadata at all → UNAUTHENTICATED ─────────────────────
{
  process.env.GRPC_SERVICE_TOKEN = TOKEN;
  let ran = false;
  const guarded = withServiceAuth(
    "test",
    makeImpl(() => (ran = true))
  );
  let err: { code?: number } | null = null;
  (
    guarded as unknown as Record<
      string,
      (c: unknown, cb: (e: unknown) => void) => void
    >
  ).ping({ ...fakeCall(), emit: () => undefined }, (e) => {
    err = e as { code?: number } | null;
  });
  assert.equal(ran, false, "missing token must NOT reach the handler");
  assert.equal(err?.code, grpc.status.UNAUTHENTICATED);
}

// ── 4. Token UNSET + production → refuse to start ───────────────────────────
{
  delete process.env.GRPC_SERVICE_TOKEN;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  assert.throws(
    () =>
      withServiceAuth(
        "test",
        makeImpl(() => undefined)
      ),
    /GRPC_SERVICE_TOKEN is required in production/,
    "production without a token must throw at startup"
  );
  process.env.NODE_ENV = prevNodeEnv;
}

// ── 5. Token UNSET + development → pass through (dev convenience) ───────────
{
  delete process.env.GRPC_SERVICE_TOKEN;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  let ran = false;
  const guarded = withServiceAuth(
    "test",
    makeImpl(() => (ran = true))
  );
  (
    guarded as unknown as Record<
      string,
      (c: unknown, cb: (e: unknown) => void) => void
    >
  ).ping({ ...fakeCall(), emit: () => undefined }, () => undefined);
  assert.equal(ran, true, "dev without a token must pass calls through");
  process.env.NODE_ENV = prevNodeEnv;
}

console.log("grpc-utils service-auth self-check: all 5 cases passed");
