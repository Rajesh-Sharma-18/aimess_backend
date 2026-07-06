import { performance } from "node:perf_hooks";
import { bucketExists } from "@aimess/storage";
import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import { presignClient } from "../config/storage.js";
import { env } from "../config/env.js";
import {
  authClient,
  getUserCountsBreaker,
  getActiveUserCountsBreaker,
} from "../grpc/auth.client.js";
import {
  communityClient,
  getCommunityCountBreaker,
} from "../grpc/community.client.js";
import { chatClient, getGroupCountBreaker } from "../grpc/chat.client.js";
import type {
  InfraHealth,
  ServiceHealth,
} from "../types/system-health.types.js";

/**
 * Live health probes for the System Health dashboard. Every probe is BOUNDED
 * (per-probe timeout) and NON-THROWING — it resolves to a normalized health row
 * even on failure/timeout — so one down dependency can never 500 or hang the
 * `/system-health` endpoint. Probes reuse the SAME primitives the readiness
 * probe and the dashboard service-status panel already use (Prisma `SELECT 1`,
 * `redis.ping`, the opossum count breakers, a bounded amqp connect, and an S3
 * HeadBucket) — no new monitoring framework is introduced.
 */

/** Wall-clock ceiling for any single probe. Matches the gRPC breaker timeout. */
const PROBE_TIMEOUT_MS = 2000;
/** Above this, a reachable dependency is reported `degraded` rather than `healthy`. */
const SLOW_SERVICE_MS = 1000;
const SLOW_INFRA_MS = 500;

class ProbeTimeoutError extends Error {
  constructor(ms: number) {
    super(`probe timed out after ${String(ms)}ms`);
    this.name = "ProbeTimeoutError";
  }
}

/**
 * Reject if `p` does not settle within `ms`. Does NOT cancel the underlying
 * operation (Prisma/Redis/amqp/S3 have no cheap cancel) — it only stops the
 * probe from waiting, which is all a health check needs.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      }
    );
  });
}

const nowIso = (): string => new Date().toISOString();
const round = (ms: number): number => Math.round(ms * 10) / 10;

function noteFrom(err: unknown): string {
  if (err instanceof ProbeTimeoutError) return err.message;
  if (err instanceof Error) return err.message;
  return "probe failed";
}

// ---------------------------------------------------------------------------
// Service probes — live gRPC ping + circuit-breaker posture
// ---------------------------------------------------------------------------

/** Minimal shape of the opossum breakers we read (kept loose for test doubles). */
interface BreakerLike {
  opened?: boolean;
  halfOpen?: boolean;
  stats?: { successes?: number; failures?: number; timeouts?: number };
}

/** Worst breaker posture across a service's breakers. */
function breakerFlag(breakers: BreakerLike[]): "open" | "half-open" | null {
  let half = false;
  for (const b of breakers) {
    if (b?.opened) return "open";
    if (b?.halfOpen) half = true;
  }
  return half ? "half-open" : null;
}

/**
 * Rolling availability (%) from the breaker window: successes ÷ (successes +
 * failures + timeouts). `null` when the window holds no samples yet.
 */
function breakerUptimePercent(breakers: BreakerLike[]): number | null {
  let ok = 0;
  let bad = 0;
  for (const b of breakers) {
    const s = b?.stats;
    if (!s) continue;
    ok += s.successes ?? 0;
    bad += (s.failures ?? 0) + (s.timeouts ?? 0);
  }
  const total = ok + bad;
  return total === 0 ? null : Math.round((ok / total) * 1000) / 10;
}

interface MonitoredServiceDef {
  key: string;
  name: string;
  breakers: BreakerLike[];
  /** Lightweight live call reused as the health ping. */
  ping: () => Promise<unknown>;
}

/**
 * Services backoffice can probe live via an existing lightweight gRPC method.
 * The ping methods (`getUserCounts`/`getCommunityCount`/`getGroupCount`) are the
 * SAME calls the dashboard overview already issues — no new RPC is added.
 */
const MONITORED_SERVICES: MonitoredServiceDef[] = [
  {
    key: "auth",
    name: "Auth Service",
    breakers: [
      getUserCountsBreaker as BreakerLike,
      getActiveUserCountsBreaker as BreakerLike,
    ],
    ping: () => authClient.getUserCounts(),
  },
  {
    key: "community",
    name: "Community Service",
    breakers: [getCommunityCountBreaker as BreakerLike],
    ping: () => communityClient.getCommunityCount(),
  },
  {
    key: "chat",
    name: "Chat Service",
    breakers: [getGroupCountBreaker as BreakerLike],
    ping: () => chatClient.getGroupCount(),
  },
];

/**
 * Services with no backoffice-side probe wired. Listed for completeness so the
 * panel shows the full topology, but `monitored:false` keeps them out of the
 * overall roll-up and the services-up tally (we never fabricate a status).
 */
const UNMONITORED_SERVICES: Array<{ key: string; name: string }> = [
  { key: "media", name: "Media Service" },
  { key: "notification", name: "Notification Service" },
  { key: "stream", name: "Livestream Service" },
  { key: "user", name: "User Service" },
];

async function probeService(def: MonitoredServiceDef): Promise<ServiceHealth> {
  const start = performance.now();
  let status: ServiceHealth["status"];
  let latencyMs: number;
  let note: string | undefined;

  try {
    await withTimeout(def.ping(), PROBE_TIMEOUT_MS);
    latencyMs = round(performance.now() - start);
    status = latencyMs > SLOW_SERVICE_MS ? "degraded" : "healthy";
    if (status === "degraded") note = `slow response (${String(latencyMs)}ms)`;
  } catch (err) {
    latencyMs = round(performance.now() - start);
    status = "down";
    note = noteFrom(err);
  }

  return {
    key: def.key,
    name: def.name,
    status,
    monitored: true,
    uptimePercent: breakerUptimePercent(def.breakers),
    latencyMs,
    breaker: breakerFlag(def.breakers),
    lastChecked: nowIso(),
    note,
  };
}

/**
 * Probe every monitored service concurrently, then append the unmonitored
 * (status `unknown`) rows. Never throws — a rejected probe is coerced to `down`.
 */
export async function probeServices(): Promise<ServiceHealth[]> {
  const settled = await Promise.allSettled(
    MONITORED_SERVICES.map(probeService)
  );
  const monitored: ServiceHealth[] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const def = MONITORED_SERVICES[i];
    return {
      key: def.key,
      name: def.name,
      status: "down",
      monitored: true,
      uptimePercent: null,
      latencyMs: null,
      breaker: null,
      lastChecked: nowIso(),
      note: noteFrom(r.reason),
    };
  });

  const unmonitored: ServiceHealth[] = UNMONITORED_SERVICES.map((s) => ({
    key: s.key,
    name: s.name,
    status: "unknown",
    monitored: false,
    uptimePercent: null,
    latencyMs: null,
    breaker: null,
    lastChecked: nowIso(),
    note: "No backoffice health probe wired — status unknown.",
  }));

  return [...monitored, ...unmonitored];
}

// ---------------------------------------------------------------------------
// Infrastructure probes — Postgres, Redis, RabbitMQ, Object Storage
// ---------------------------------------------------------------------------

function infra(
  key: string,
  name: string,
  status: InfraHealth["status"],
  metrics: InfraHealth["metrics"],
  latencyMs: number | null,
  note?: string
): InfraHealth {
  return { key, name, status, metrics, latencyMs, lastChecked: nowIso(), note };
}

/** admin_db reachability — the same `SELECT 1` the readiness probe runs. */
export async function probePostgres(): Promise<InfraHealth> {
  const start = performance.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS);
    const latencyMs = round(performance.now() - start);
    return infra(
      "database",
      "Database (PostgreSQL)",
      latencyMs > SLOW_INFRA_MS ? "degraded" : "healthy",
      { latencyMs, engine: "postgresql" },
      latencyMs
    );
  } catch (err) {
    return infra(
      "database",
      "Database (PostgreSQL)",
      "down",
      { latencyMs: null, engine: "postgresql" },
      null,
      noteFrom(err)
    );
  }
}

/** Redis reachability — the same `PING` the readiness probe runs. */
export async function probeRedis(): Promise<InfraHealth> {
  const start = performance.now();
  try {
    const pong = await withTimeout(redis.ping(), PROBE_TIMEOUT_MS);
    const latencyMs = round(performance.now() - start);
    const healthy = pong === "PONG";
    return infra(
      "redis",
      "Redis",
      healthy ? (latencyMs > SLOW_INFRA_MS ? "degraded" : "healthy") : "down",
      { latencyMs, connection: redis.status ?? "unknown" },
      latencyMs,
      healthy ? undefined : `unexpected PING reply: ${String(pong)}`
    );
  } catch (err) {
    return infra(
      "redis",
      "Redis",
      "down",
      { latencyMs: null, connection: redis.status ?? "unknown" },
      null,
      noteFrom(err)
    );
  }
}

/**
 * RabbitMQ reachability — a bounded connect + channel open/close, mirroring the
 * connection the messaging consumers/publishers make. The connection is always
 * closed; nothing is published.
 */
export async function probeRabbitMq(): Promise<InfraHealth> {
  const start = performance.now();
  let connection: amqp.ChannelModel | undefined;
  try {
    connection = await withTimeout(
      amqp.connect(env.RABBITMQ_URL),
      PROBE_TIMEOUT_MS
    );
    const channel = await connection.createChannel();
    await channel.close();
    const latencyMs = round(performance.now() - start);
    return infra(
      "message_queue",
      "Message Queue (RabbitMQ)",
      latencyMs > SLOW_INFRA_MS ? "degraded" : "healthy",
      { latencyMs, transport: "amqp" },
      latencyMs
    );
  } catch (err) {
    return infra(
      "message_queue",
      "Message Queue (RabbitMQ)",
      "down",
      { latencyMs: null, transport: "amqp" },
      null,
      noteFrom(err)
    );
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        logger.warn("health: failed to close RabbitMQ probe connection");
        logger.warn(closeErr);
      }
    }
  }
}

/**
 * Object storage reachability — a HEAD on the shared avatars bucket via the
 * existing presign client. Reuses the S3/MinIO client backoffice already holds;
 * no object is read or written.
 */
export async function probeObjectStorage(): Promise<InfraHealth> {
  const bucket = env.MINIO_BUCKET_AVATARS;
  const start = performance.now();
  try {
    await withTimeout(bucketExists(presignClient, bucket), PROBE_TIMEOUT_MS);
    const latencyMs = round(performance.now() - start);
    return infra(
      "object_storage",
      "Object Storage (MinIO)",
      latencyMs > SLOW_INFRA_MS ? "degraded" : "healthy",
      { latencyMs, bucket },
      latencyMs
    );
  } catch (err) {
    return infra(
      "object_storage",
      "Object Storage (MinIO)",
      "down",
      { latencyMs: null, bucket },
      null,
      noteFrom(err)
    );
  }
}

/** Probe all four infrastructure components concurrently; never throws. */
export async function probeInfrastructure(): Promise<InfraHealth[]> {
  const probes: Array<Promise<InfraHealth>> = [
    probePostgres(),
    probeRedis(),
    probeRabbitMq(),
    probeObjectStorage(),
  ];
  const settled = await Promise.allSettled(probes);
  const fallbackKeys = ["database", "redis", "message_queue", "object_storage"];
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : infra(
          fallbackKeys[i],
          fallbackKeys[i],
          "down",
          { latencyMs: null },
          null,
          noteFrom(r.reason)
        )
  );
}
