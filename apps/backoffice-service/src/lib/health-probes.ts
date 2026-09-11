import { performance } from "node:perf_hooks";
import net from "node:net";
import { bucketExists } from "@aimess/storage";
import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import { presignClient } from "../config/storage.js";
import { env } from "../config/env.js";
import type {
  InfraHealth,
  ServiceHealth,
} from "../types/system-health.types.js";
import type { InfraProbeDef, ServiceProbeDef } from "./health-registry.js";

/**
 * Reusable, framework-free health-probe primitives for the System Health
 * dashboard. Every probe is BOUNDED (per-probe timeout) and NON-THROWING — it
 * resolves to a normalized health row even on failure/timeout — so one down
 * dependency can never 500 or hang the `/system-health` endpoint. Probes reuse
 * the SAME primitives the readiness probe and the dashboard service-status
 * panel already use (Prisma `SELECT 1`, `redis.ping`, the opossum count
 * breakers, a bounded amqp connect, and an S3 HeadBucket).
 *
 * This module owns HOW to probe a dependency. WHICH dependencies exist lives
 * in `src/probes/*.probe.ts`, registered once in `health.bootstrap.ts` — this
 * file never lists services/infrastructure by name.
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

const nowMs = (): number => Date.now();
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

/**
 * Shape for a service probed live via an existing lightweight gRPC method
 * (e.g. `getUserCounts`/`getCommunityCount`/`getGroupCount` — the SAME calls
 * the dashboard overview already issues, no new RPC is added). One of these
 * is built per service inside its own `src/probes/*.service.probe.ts` file.
 */
export interface MonitoredServiceDef {
  key: string;
  name: string;
  breakers: BreakerLike[];
  /** Lightweight live call reused as the health ping. */
  ping: () => Promise<unknown>;
}

/**
 * Shape for a service probed via its HTTP `/health` endpoint. Every service in
 * the monorepo already exposes one (see each app's routes/health.routes.ts,
 * returns `{status:"ok"}` on 200) — reusing it keeps the probe uniform and
 * dependency-free (no new gRPC clients). `breaker`/`uptimePercent` stay null
 * because no backoffice-side circuit backs the call — the ping is the whole
 * signal.
 */
export interface HttpMonitoredServiceDef {
  key: string;
  name: string;
  url: string;
}

export async function probeService(
  def: MonitoredServiceDef
): Promise<ServiceHealth> {
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
    lastChecked: nowMs(),
    note,
  };
}

/**
 * Rolling-window uptime% for the HTTP-probed services. No backoffice-side
 * circuit breaker backs the /health call, so we keep the last N observations
 * per service key in memory and derive availability as ok/(ok+bad)*100.
 * ~5s cache × 100 slots ≈ 8min of history — plenty for a live dashboard.
 * ponytail: in-memory only; a service restart resets to null-until-first-probe.
 */
const HTTP_UPTIME_WINDOW = 100;
const httpUptimeWindow = new Map<string, boolean[]>();
function recordHttpProbe(key: string, ok: boolean): number {
  const arr = httpUptimeWindow.get(key) ?? [];
  arr.push(ok);
  if (arr.length > HTTP_UPTIME_WINDOW) arr.shift();
  httpUptimeWindow.set(key, arr);
  const good = arr.filter(Boolean).length;
  return Math.round((good / arr.length) * 1000) / 10;
}

/**
 * HTTP `/health` probe — bounded via AbortSignal so it honors PROBE_TIMEOUT_MS.
 * Any non-2xx or network failure resolves to `down`; a slow-but-2xx response
 * degrades to `degraded`. Never throws.
 */
export async function probeHttpService(
  def: HttpMonitoredServiceDef
): Promise<ServiceHealth> {
  const start = performance.now();
  let status: ServiceHealth["status"];
  let latencyMs: number;
  let note: string | undefined;

  try {
    const res = await fetch(`${def.url}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    latencyMs = round(performance.now() - start);
    if (!res.ok) {
      status = "down";
      note = `HTTP ${String(res.status)}`;
    } else {
      status = latencyMs > SLOW_SERVICE_MS ? "degraded" : "healthy";
      if (status === "degraded")
        note = `slow response (${String(latencyMs)}ms)`;
    }
  } catch (err) {
    latencyMs = round(performance.now() - start);
    status = "down";
    note = noteFrom(err);
  }

  const uptimePercent = recordHttpProbe(def.key, status !== "down");
  return {
    key: def.key,
    name: def.name,
    status,
    monitored: true,
    uptimePercent,
    latencyMs,
    breaker: null,
    lastChecked: nowMs(),
    note,
  };
}

/** A registered service with no probe wired yet — visible but unmonitored. */
function unknownService(def: { key: string; name: string }): ServiceHealth {
  return {
    key: def.key,
    name: def.name,
    status: "unknown",
    monitored: false,
    uptimePercent: null,
    latencyMs: null,
    breaker: null,
    lastChecked: nowMs(),
  };
}

/**
 * Probe every service registered in `entries` (read from
 * `healthServiceRegistry.getServices()` by the caller) concurrently. Never
 * throws — a rejected probe is coerced to a `down` row so one down dependency
 * can never fail the whole /system-health response. A registered service with
 * no probe is reported `monitored:false`/`unknown` without being called.
 */
export async function probeServices(
  entries: ServiceProbeDef[]
): Promise<ServiceHealth[]> {
  const settled = await Promise.allSettled(
    entries.map((e) =>
      e.probe ? e.probe() : Promise.resolve(unknownService(e))
    )
  );
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const def = entries[i];
    return {
      key: def.key,
      name: def.name,
      status: "down",
      monitored: true,
      uptimePercent: null,
      latencyMs: null,
      breaker: null,
      lastChecked: nowMs(),
      note: noteFrom(r.reason),
    };
  });
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
  return { key, name, status, metrics, latencyMs, lastChecked: nowMs(), note };
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

/**
 * Bounded TCP connect — the cheapest honest reachability signal for a
 * dependency backoffice holds no client for. Resolves the connect latency, or
 * rejects on refusal/timeout; the socket is always destroyed.
 *
 * ponytail: port-open only, not a protocol handshake — a listening-but-wedged
 * daemon still reads as up. Upgrade to a real client ping if that matters.
 */
function tcpConnect(host: string, port: number): Promise<number> {
  const start = performance.now();
  return new Promise<number>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const done = (err?: Error): void => {
      socket.destroy();
      if (err) reject(err);
      else resolve(round(performance.now() - start));
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done());
    socket.once("timeout", () => done(new ProbeTimeoutError(PROBE_TIMEOUT_MS)));
    socket.once("error", (err: Error) => done(err));
  });
}

/**
 * Mongo host/port for the probe. `MONGO_DATABASE_URL` (the same connection
 * string the Mongo-backed services use) wins when set; the first host of a
 * seed list is probed, since any one reachable member proves the cluster is
 * addressable.
 */
function mongoTarget(): { host: string; port: number } {
  const url = env.MONGO_DATABASE_URL;
  if (url) {
    // `new URL` rejects multi-host seed lists, so take the first host manually.
    const authority = url.replace(/^mongodb(\+srv)?:\/\//, "").split("/")[0];
    const hostPart = (authority.split("@").pop() ?? "").split(",")[0];
    const [host, port] = hostPart.split(":");
    if (host) return { host, port: Number(port) || env.MONGODB_PORT };
  }
  return { host: env.MONGODB_HOST, port: env.MONGODB_PORT };
}

/** MongoDB reachability — bounded TCP connect to the shared instance. */
export async function probeMongo(): Promise<InfraHealth> {
  const { host, port } = mongoTarget();
  try {
    const latencyMs = await tcpConnect(host, port);
    return infra(
      "mongodb",
      "Document Database (MongoDB)",
      latencyMs > SLOW_INFRA_MS ? "degraded" : "healthy",
      { latencyMs, engine: "mongodb", host: `${host}:${String(port)}` },
      latencyMs
    );
  } catch (err) {
    return infra(
      "mongodb",
      "Document Database (MongoDB)",
      "down",
      { latencyMs: null, engine: "mongodb", host: `${host}:${String(port)}` },
      null,
      noteFrom(err)
    );
  }
}

/**
 * ClamAV reachability — clamd's own `zPING` command (null-terminated, the
 * modern form) which answers `PONG`. Cheaper and more truthful than a bare
 * connect: it proves the daemon is answering, not just listening.
 */
function clamavPing(host: string, port: number): Promise<number> {
  const start = performance.now();
  return new Promise<number>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let reply = "";
    const done = (err?: Error): void => {
      socket.destroy();
      if (err) reject(err);
      else resolve(round(performance.now() - start));
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => socket.write("zPING\0"));
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("utf8");
      if (reply.includes("PONG")) done();
    });
    socket.once("timeout", () => done(new ProbeTimeoutError(PROBE_TIMEOUT_MS)));
    socket.once("error", (err: Error) => done(err));
    socket.once("close", () => {
      if (!reply.includes("PONG"))
        done(new Error(`unexpected PING reply: ${reply.trim() || "(empty)"}`));
    });
  });
}

/** ClamAV antivirus daemon — media-service scans through it post-upload. */
export async function probeClamAv(): Promise<InfraHealth> {
  const host = env.CLAMAV_HOST;
  const port = env.CLAMAV_PORT;
  const target = `${host}:${String(port)}`;
  try {
    const latencyMs = await clamavPing(host, port);
    return infra(
      "antivirus",
      "Antivirus (ClamAV)",
      latencyMs > SLOW_INFRA_MS ? "degraded" : "healthy",
      { latencyMs, host: target },
      latencyMs
    );
  } catch (err) {
    return infra(
      "antivirus",
      "Antivirus (ClamAV)",
      "down",
      { latencyMs: null, host: target },
      null,
      noteFrom(err)
    );
  }
}

/**
 * SRS media server — its unauthenticated `GET /api/v1/versions`, the lightest
 * call on the same HTTP API stream-service already drives.
 */
export async function probeSrs(): Promise<InfraHealth> {
  const start = performance.now();
  try {
    const res = await fetch(`${env.SRS_API_URL}/api/v1/versions`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = round(performance.now() - start);
    if (!res.ok) {
      return infra(
        "media_server",
        "Media Server (SRS)",
        "down",
        { latencyMs: null, protocol: "http-api" },
        null,
        `HTTP ${String(res.status)}`
      );
    }
    const body = (await res.json()) as { data?: { version?: string } };
    return infra(
      "media_server",
      "Media Server (SRS)",
      latencyMs > SLOW_INFRA_MS ? "degraded" : "healthy",
      { latencyMs, version: body.data?.version ?? null, protocol: "http-api" },
      latencyMs
    );
  } catch (err) {
    return infra(
      "media_server",
      "Media Server (SRS)",
      "down",
      { latencyMs: null, protocol: "http-api" },
      null,
      noteFrom(err)
    );
  }
}

/**
 * LiveKit (calls SFU) — its unauthenticated root path answers `OK` on the same
 * port as signaling, so no API key is needed to tell up from down. `LIVEKIT_URL`
 * is a ws(s):// URL for clients; the health call needs http(s).
 */
export async function probeLiveKit(): Promise<InfraHealth> {
  const url = env.LIVEKIT_URL.replace(/^ws/, "http");
  const start = performance.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = round(performance.now() - start);
    if (!res.ok) {
      return infra(
        "livekit",
        "Calls SFU (LiveKit)",
        "down",
        { latencyMs: null, transport: "webrtc" },
        null,
        `HTTP ${String(res.status)}`
      );
    }
    return infra(
      "livekit",
      "Calls SFU (LiveKit)",
      latencyMs > SLOW_INFRA_MS ? "degraded" : "healthy",
      { latencyMs, transport: "webrtc" },
      latencyMs
    );
  } catch (err) {
    return infra(
      "livekit",
      "Calls SFU (LiveKit)",
      "down",
      { latencyMs: null, transport: "webrtc" },
      null,
      noteFrom(err)
    );
  }
}

/**
 * Probe every infrastructure dependency registered in `entries` (read from
 * `healthInfrastructureRegistry.getInfrastructure()` by the caller)
 * concurrently; never throws.
 */
export async function probeInfrastructure(
  entries: InfraProbeDef[]
): Promise<InfraHealth[]> {
  const settled = await Promise.allSettled(entries.map((e) => e.probe()));
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const def = entries[i];
    return infra(
      def.key,
      def.name,
      "down",
      { latencyMs: null },
      null,
      noteFrom(r.reason)
    );
  });
}
