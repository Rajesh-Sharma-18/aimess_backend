import RedisModule from "ioredis";
import type { Redis } from "ioredis";
import type { Store, ClientRateLimitInfo, Options } from "express-rate-limit";

import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

/**
 * Rate-limit counters in Redis, shared by every gateway replica.
 *
 * express-rate-limit's default store keeps counters in process memory, which
 * has two consequences the limits were never meant to have:
 *
 *  - every restart or redeploy wipes them, so an attacker mid-way through a
 *    credential-stuffing run gets a fresh budget just by waiting for (or
 *    triggering) a deploy;
 *  - and the moment a second replica exists, every limit multiplies by the
 *    replica count. The nginx config for the API already carries `ip_hash`
 *    "before a second gateway pod is added", and `ip_hash` lets a client choose
 *    its replica by source address — so the multiplication is selectable, not
 *    merely incidental.
 *
 * Written against the ioredis client the gateway already uses rather than
 * pulling in `rate-limit-redis`: the Store interface is four methods, and
 * implementing it directly keeps the failure policy explicit and visible
 * instead of hidden behind a flag.
 */

/** Dedicated command client — the socket pub/sub clients cannot run commands. */
let client: Redis | null = null;

function getClient(): Redis {
  client ??= (() => {
    const created = new RedisModule.default(env.REDIS_URL, {
      lazyConnect: true,
      // Fail fast: a limiter that waits on a hung Redis turns a cache problem
      // into a latency problem on every single request.
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
      enableOfflineQueue: false,
    }) as Redis;
    created.on("error", () => {
      /* Errors surface as command rejections; a listener stops ioredis from
         treating them as unhandled and crashing the process. */
    });
    void created.connect().catch(() => {
      /* Retried by ioredis; `increment` fails open until it succeeds. */
    });
    return created;
  })();
  return client;
}

/**
 * Increment, expire and read the TTL in one round trip.
 *
 * `PEXPIRE key ttl NX` sets the window only on the first hit, so the window is
 * fixed from the first request rather than sliding forward on every one — which
 * would let a steady stream of requests hold a key alive forever and never
 * reset the count.
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { hits, ttl }
`;

export class RedisRateLimitStore implements Store {
  /** Keys are shared across replicas, which is the entire point. */
  localKeys = false;

  private windowMs = 60_000;
  /** Namespace for every gateway limiter key. Public: part of the Store interface. */
  prefix = "rl:gw:";

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const namespaced = this.prefix + key;

    try {
      const [hits, ttl] = (await getClient().eval(
        INCREMENT_SCRIPT,
        1,
        namespaced,
        String(this.windowMs)
      )) as [number, number];

      return {
        totalHits: hits,
        resetTime: new Date(Date.now() + (ttl > 0 ? ttl : this.windowMs)),
      };
    } catch (err) {
      // FAIL OPEN, deliberately.
      //
      // Returning a hit count of 1 lets the request through. The alternative —
      // propagating the error — turns a Redis blip into a 500 on every request
      // to the entire API, which is a far worse outcome than briefly
      // unthrottled traffic. This mirrors `passOnStoreError` in
      // `rate-limit-redis`, made explicit so the choice is visible.
      //
      // The per-service limiters that guard WRITE paths take the opposite
      // stance and degrade to an in-process counter; this is the edge backstop,
      // and availability wins here.
      logger.warn("rate_limit_store_unavailable", {
        service: "api-gateway",
        detail: err instanceof Error ? err.message : String(err),
      });
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await getClient().decr(this.prefix + key);
    } catch {
      // Only used by `skipSuccessfulRequests`; a missed decrement costs the
      // caller one request of quota and is not worth failing over.
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await getClient().del(this.prefix + key);
    } catch {
      /* The key expires on its own. */
    }
  }
}
