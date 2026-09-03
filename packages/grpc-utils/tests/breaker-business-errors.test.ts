/**
 * Self-check for the breaker's business-vs-infrastructure error split.
 *
 * The case that matters is RESOURCE_EXHAUSTED. Every messaging send is charged
 * against a per-user rate limit, and its refusal reaches the caller as that
 * status. While it counted as an infrastructure failure, a throttled burst
 * opened the circuit — and once open, `fallback()` replaced the callee's status
 * with a bare "<name> unavailable" Error, so the client could not tell a rate
 * limit from an outage and had no code to back off on.
 *
 * Same plain-assert style as service-auth.test.ts, for the same reason.
 *
 *   pnpm --filter @aimess/grpc-utils test
 */
import assert from "node:assert/strict";
import * as grpc from "@grpc/grpc-js";

import { makeBreaker } from "../src/index.js";

function grpcError(code: number): Error & { code: number } {
  return Object.assign(new Error(`status ${code}`), { code });
}

/** Drive one breaker past its volume + error thresholds with the given status. */
async function rejectRepeatedly(
  name: string,
  code: number,
  times: number
): Promise<unknown[]> {
  const breaker = makeBreaker<number, never>(name, () =>
    Promise.reject(grpcError(code))
  );
  const seen: unknown[] = [];
  for (let i = 0; i < times; i += 1) {
    await breaker.fire(i).then(
      () => seen.push(null),
      (err: unknown) => seen.push(err)
    );
  }
  return seen;
}

async function main(): Promise<void> {
  // A rate-limit refusal must reach the caller intact, however many of them
  // arrive: the code survives and the breaker never swaps in its fallback.
  {
    const seen = await rejectRepeatedly(
      "test.rateLimited",
      grpc.status.RESOURCE_EXHAUSTED,
      20
    );
    for (const err of seen) {
      assert.equal(
        (err as { code?: number }).code,
        grpc.status.RESOURCE_EXHAUSTED,
        "RESOURCE_EXHAUSTED must pass through with its status intact"
      );
      assert.ok(
        !/unavailable/.test(String((err as Error).message)),
        "a rate limit must never be reported as the service being unavailable"
      );
    }
  }

  // The counterpart: a genuine infrastructure failure still trips the circuit
  // and still gets the generic fallback, so this did not disarm the breaker.
  {
    const seen = await rejectRepeatedly(
      "test.unhealthy",
      grpc.status.UNAVAILABLE,
      20
    );
    const fellBack = seen.some((err) =>
      /test\.unhealthy unavailable/.test(String((err as Error).message))
    );
    assert.ok(
      fellBack,
      "UNAVAILABLE must still count toward the breaker and hit the fallback"
    );
  }

  // An ordinary business rejection is unchanged.
  {
    const seen = await rejectRepeatedly(
      "test.notFound",
      grpc.status.NOT_FOUND,
      20
    );
    for (const err of seen) {
      assert.equal((err as { code?: number }).code, grpc.status.NOT_FOUND);
    }
  }

  console.log(
    "grpc-utils breaker business-error self-check: all 3 cases passed"
  );
}

void main();
