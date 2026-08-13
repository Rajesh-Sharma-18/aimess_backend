/**
 * Virus / malware scan engine + scan-status lifecycle store.
 *
 * Architecture:
 *   1. Client PUTs file to MinIO presigned URL.
 *   2. Client calls POST /media/confirm.
 *   3. confirm handler downloads first N bytes → magic-byte check, then
 *      streams the full object through the active scanner.
 *   4. scanner.scan() returns CLEAN / INFECTED / SKIPPED / ERROR.
 *   5. Status is written to Redis (scanStatusStore) and the objectKey is
 *      quarantined (deleted from MinIO) if INFECTED.
 *   6. generateDownloadUrl gates on scanStatusStore.get() before issuing a
 *      presigned GET, so an unscanned or infected file can never be served.
 *
 * Swapping scanners:
 *   Set CLAMAV_ENABLED=true + CLAMAV_HOST + CLAMAV_PORT to activate ClamAV.
 *   The createScanner() factory reads env at startup and returns the right impl.
 *   Everything downstream depends only on the MediaScanner interface.
 */

import * as net from "node:net";
import { createHash } from "node:crypto";
import Queue from "bull";
import type { Queue as BullQueue, Job } from "bull";
import { publishUserSocketEvent, type Redis } from "@aimess/redis";

import { logger } from "@aimess/logger";
import type { MediaScanStatus } from "@aimess/constants";
import { getObjectBytes, extractOwnerIdFromObjectKey } from "@aimess/storage";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { storageClient } from "../config/storage.js";
import { quarantineObject, recordVerdict } from "./media-cleanup.js";

// ─── Types ───────────────────────────────────────────────────────────────────

// Scan-status lifecycle is the canonical @aimess/constants vocabulary (single
// source of truth shared with the MediaFile registry + download-access gate),
// imported above. Re-exported so callers can keep importing it from the scanner
// module rather than reaching into @aimess/constants directly.
export type { MediaScanStatus };

export interface MediaScanInput {
  bucket: string;
  objectKey: string;
  contentType: string;
  /** Full object bytes (streamed from MinIO for scanning). */
  data: Buffer;
}

export interface MediaScanResult {
  status: Exclude<MediaScanStatus, "PENDING" | "QUARANTINED">;
  /** Engine-specific detail (signature name on INFECTED, reason on ERROR). */
  details?: string;
}

export interface MediaScanner {
  /**
   * Scan stored bytes. Implementations MUST NOT throw — surface failures as
   * `{ status: "ERROR" }` so the caller decides whether to block or allow.
   */
  scan(input: MediaScanInput): Promise<MediaScanResult>;
}

// ─── No-op scanner (default when ClamAV disabled) ────────────────────────────

export class NoopMediaScanner implements MediaScanner {
  scan(input: MediaScanInput): Promise<MediaScanResult> {
    void input;
    return Promise.resolve({ status: "SKIPPED" });
  }
}

// ─── ClamAV scanner (TCP socket, clamd INSTREAM protocol) ────────────────────

/**
 * Streams file bytes to a running clamd daemon over TCP using the INSTREAM
 * command. No additional npm dependencies — uses Node's built-in `net` module.
 *
 * INSTREAM protocol:
 *   1. Send "zINSTREAM\0"
 *   2. For each chunk: send 4-byte big-endian length header + chunk bytes
 *   3. Send 4-byte zero to signal end-of-stream
 *   4. Read response: "stream: OK\n" or "stream: <VirusName> FOUND\n"
 *
 * Reference: https://linux.die.net/man/8/clamd (INSTREAM section)
 */
export class ClamAVScanner implements MediaScanner {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(host: string, port: number, timeoutMs: number) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  async scan(input: MediaScanInput): Promise<MediaScanResult> {
    try {
      const response = await this.streamToClamd(input.data);
      if (response.includes("OK")) {
        return { status: "CLEAN" };
      }
      if (response.includes("FOUND")) {
        const signature = response
          .replace("stream:", "")
          .replace("FOUND", "")
          .trim();
        return { status: "INFECTED", details: signature };
      }
      return {
        status: "ERROR",
        details: `Unexpected clamd response: ${response}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn("ClamAV scan error", {
        objectKey: input.objectKey,
        error: msg,
      });
      return { status: "ERROR", details: msg };
    }
  }

  private streamToClamd(data: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(
        { host: this.host, port: this.port },
        () => {
          // Send INSTREAM command (null-terminated)
          socket.write(Buffer.from("zINSTREAM\0"));

          // Send file in 64 KB chunks (defensive; clamd handles larger but
          // chunking keeps memory pressure predictable for large files)
          const CHUNK = 65536;
          for (let offset = 0; offset < data.length; offset += CHUNK) {
            const chunk = data.subarray(offset, offset + CHUNK);
            const lenBuf = Buffer.allocUnsafe(4);
            lenBuf.writeUInt32BE(chunk.length, 0);
            socket.write(lenBuf);
            socket.write(chunk);
          }

          // Zero-length chunk signals end of stream
          socket.write(Buffer.from([0, 0, 0, 0]));
        }
      );

      socket.setTimeout(this.timeoutMs);

      let response = "";
      socket.on("data", (chunk: Buffer) => {
        response += chunk.toString("utf8");
      });

      socket.on("end", () => resolve(response.trim()));
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error(`ClamAV socket timed out after ${this.timeoutMs}ms`));
      });
      socket.on("error", (err) => {
        reject(err);
      });
    });
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createScanner(): MediaScanner {
  if (env.CLAMAV_ENABLED) {
    logger.info(
      `ClamAV scanner enabled — connecting to ${env.CLAMAV_HOST}:${env.CLAMAV_PORT}`
    );
    return new ClamAVScanner(
      env.CLAMAV_HOST,
      env.CLAMAV_PORT,
      env.CLAMAV_SCAN_TIMEOUT_MS
    );
  }
  logger.warn(
    "CLAMAV_ENABLED=false — using no-op scanner. Set CLAMAV_ENABLED=true in production."
  );
  return new NoopMediaScanner();
}

/** The active scanner singleton. Resolved at module load from env. */
export const mediaScanner: MediaScanner = createScanner();

// ─── Scan-status Redis store ──────────────────────────────────────────────────

const SCAN_KEY_PREFIX = "media:scan:";

function scanKey(objectKey: string): string {
  return `${SCAN_KEY_PREFIX}${objectKey}`;
}

/**
 * Persistent scan-status store backed by Redis.
 *
 * Lifecycle:
 *   PENDING    → written immediately when client calls /confirm, before scan
 *   CLEAN      → written after CLEAN scan result (all checks passed)
 *   QUARANTINED → written after rejected magic-byte / ZIP inspection
 *   INFECTED   → written after INFECTED AV scan result
 *   SKIPPED    → written when no-op scanner is active (dev mode)
 *   ERROR      → not written to Redis; status remains PENDING so client retries
 *   missing    → file never confirmed (upload-url issued; confirm not called)
 *
 * generateDownloadUrl gates on PENDING / QUARANTINED / INFECTED.
 */
export const scanStatusStore = {
  async set(
    objectKey: string,
    status: MediaScanStatus,
    redisClient: Redis = redis
  ): Promise<void> {
    await redisClient.set(
      scanKey(objectKey),
      status,
      "EX",
      env.SCAN_STATUS_TTL_SECONDS
    );
  },

  async get(
    objectKey: string,
    redisClient: Redis = redis
  ): Promise<MediaScanStatus | null> {
    const raw = await redisClient.get(scanKey(objectKey));
    return raw as MediaScanStatus | null;
  },

  async del(objectKey: string, redisClient: Redis = redis): Promise<void> {
    await redisClient.del(scanKey(objectKey));
  },
};

// ─── Realtime scan-failure notify ─────────────────────────────────────────────

/**
 * Best-effort realtime notice to the uploader that their upload was blocked.
 *
 * The download gate already protects the file regardless of this publish, so a
 * failure here must NEVER throw or fail the scan — it only saves an uploader who
 * stopped polling from never learning the verdict. We derive the uploader id
 * from the object key (`{prefix}/{ownerId}/...`) and publish to the user's
 * `notify:<uploaderId>` Redis channel; the gateway `/notify` namespace relays it
 * verbatim to the uploader's connected sockets. Socket-only by design — offline
 * FCM is intentionally out of scope.
 */
export function publishScanResult(
  objectKey: string,
  status: MediaScanStatus
): void {
  const uploaderId = extractOwnerIdFromObjectKey(objectKey);
  if (!uploaderId) {
    logger.warn("media-scan: cannot derive uploaderId — skipping notify", {
      objectKey,
    });
    return;
  }
  // The payload carries the STATUS ONLY.
  //
  // It used to carry a free-text `reason`, and the three callers fed it: the
  // ClamAV signature name for a detection, the raw structural-validator string
  // (which embeds thresholds and byte offsets — "ZIP compression ratio 140.0:1
  // exceeds limit of 100:1"), and, on a terminal Bull failure, whatever error
  // escaped — including MinIO SDK messages carrying the endpoint and bucket.
  // None of that helps the uploader and all of it helps an attacker calibrate
  // against the detectors. The detail is written to the audit log and
  // `MediaFile.scanDetail` instead.
  void publishUserSocketEvent(redis, uploaderId, "media:scan_result", {
    objectKey,
    status,
    at: Date.now(),
  }).catch((err: unknown) =>
    logger.warn("media-scan: scan_result notify publish failed", {
      objectKey,
      error: err instanceof Error ? err.message : String(err),
    })
  );
}

// ─── Async scan queue (Bull) ──────────────────────────────────────────────────

export interface MediaScanJob {
  bucket: string;
  objectKey: string;
  contentType: string;
}

let scanQueue: BullQueue<MediaScanJob> | null = null;

/**
 * Lazily-created Bull queue for off-thread AV scanning. Bull creates and
 * configures its OWN Redis clients (bclient/subscriber need maxRetriesPerRequest
 * = null), so we pass plain connection options — NEVER the shared @aimess/redis
 * singleton.
 */
export function getScanQueue(): BullQueue<MediaScanJob> {
  if (!scanQueue) {
    scanQueue = new Queue<MediaScanJob>(env.MEDIA_SCAN_QUEUE_NAME, {
      redis: {
        host: env.BULL_REDIS_HOST,
        port: env.BULL_REDIS_PORT,
        // Falls back to the main Redis password so the common case (Bull and
        // the cache on the same authenticated instance) needs one variable.
        password: env.BULL_REDIS_PASSWORD ?? env.REDIS_PASSWORD,
      },
      defaultJobOptions: {
        attempts: env.MEDIA_SCAN_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: env.MEDIA_SCAN_BACKOFF_MS },
        timeout: env.CLAMAV_SCAN_TIMEOUT_MS + 10_000,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    });
    scanQueue.on("error", (e: Error) =>
      logger.warn("media-scan queue error", { error: e?.message })
    );
  }
  return scanQueue;
}

/**
 * Enqueue an AV scan job. Returns false (never throws) if Bull/Redis is
 * unavailable, so the caller can fall back to an inline scan.
 */
export async function enqueueScan(job: MediaScanJob): Promise<boolean> {
  try {
    await getScanQueue().add(job);
    return true;
  } catch (err) {
    logger.warn("Failed to enqueue media-scan job — caller should fall back", {
      objectKey: job.objectKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Fetch the stored object, run the AV scan, and persist the terminal status to
 * Redis. Shared by the Bull worker AND the inline enqueue-failure fallback so
 * the scan logic lives in exactly one place. Never throws.
 *
 * Returns the resolved status. "PENDING" means the scan could not complete
 * (bytes missing or scanner ERROR) and Redis was NOT updated — the worker turns
 * this into a thrown error so Bull retries.
 */
export async function runScanAndPersist(
  job: MediaScanJob
): Promise<MediaScanStatus> {
  const { bucket, objectKey, contentType } = job;
  const fullBuf = await getObjectBytes(storageClient, bucket, objectKey);
  if (!fullBuf) {
    logger.warn("media-scan: object bytes unavailable — leaving PENDING", {
      objectKey,
    });
    return "PENDING";
  }

  const result = await mediaScanner.scan({
    bucket,
    objectKey,
    contentType,
    data: fullBuf,
  });

  const sha256 = createHash("sha256").update(fullBuf).digest("hex");

  if (result.status === "INFECTED") {
    logger.error("media-scan: INFECTED — quarantining", {
      severity: "critical",
      event: "media.malware_detected",
      objectKey,
      signature: result.details,
      sha256,
      size: fullBuf.length,
      contentType,
    });
    await scanStatusStore.set(objectKey, "INFECTED");
    // Durable verdict + logged-on-failure delete. Previously this was a bare
    // `deleteObject`, so a delete failure escaped into Bull AFTER Redis had
    // already been marked terminal — leaving known-malicious bytes in the bucket
    // with nothing recording that fact.
    await quarantineObject({
      bucket,
      objectKey,
      status: "INFECTED",
      detail: result.details ?? "malware signature detected",
      sha256,
    });
    publishScanResult(objectKey, "INFECTED");
    return "INFECTED";
  }

  if (result.status === "ERROR") {
    logger.warn("media-scan: scanner ERROR — leaving PENDING for retry", {
      objectKey,
      detail: result.details,
    });
    return "PENDING";
  }

  // CLEAN → downloadable. Written to BOTH Redis (hot) and the registry (durable)
  // so the verdict survives a cache flush or TTL expiry.
  await scanStatusStore.set(objectKey, "CLEAN");
  await recordVerdict({
    objectKey,
    status: "CLEAN",
    detail: result.status === "SKIPPED" ? "AV scanning disabled" : undefined,
    sha256,
  });
  logger.info("media-security", {
    event: "media.scan_clean",
    objectKey,
    contentType,
    size: fullBuf.length,
    sha256,
    scanner: env.CLAMAV_ENABLED ? "clamav" : "noop",
    at: new Date().toISOString(),
  });
  return "CLEAN";
}

/**
 * Register the in-process Bull worker. Call once at boot (only when
 * CLAMAV_ENABLED=true). On a scan that cannot resolve (bytes missing / scanner
 * ERROR) it throws so Bull retries with exponential backoff; once all attempts
 * are exhausted it writes a terminal ERROR status so polling clients stop.
 */
export function startScanWorker(): void {
  const queue = getScanQueue();

  queue.process(env.MEDIA_SCAN_CONCURRENCY, async (job: Job<MediaScanJob>) => {
    const status = await runScanAndPersist(job.data);
    if (status === "PENDING") {
      throw new Error(`media-scan unresolved for ${job.data.objectKey}`);
    }
    return status;
  });

  queue.on("failed", (job: Job<MediaScanJob>, err: Error) => {
    if (
      job.attemptsMade >= (job.opts.attempts ?? env.MEDIA_SCAN_JOB_ATTEMPTS)
    ) {
      // All retries exhausted — record terminal ERROR so the client stops
      // polling. The object stays in storage but the download gate keeps
      // blocking until a re-confirm succeeds.
      logger.error("media-scan: job failed after all retries", {
        severity: "critical",
        event: "media.scan_exhausted",
        objectKey: job.data.objectKey,
        error: err?.message,
      });
      void scanStatusStore.set(job.data.objectKey, "ERROR");
      void recordVerdict({
        objectKey: job.data.objectKey,
        status: "ERROR",
        detail: `scan retries exhausted: ${err?.message ?? "unknown"}`,
      });
      publishScanResult(job.data.objectKey, "ERROR");
    }
  });

  logger.info(
    `media-scan worker started (concurrency=${env.MEDIA_SCAN_CONCURRENCY})`
  );
}
