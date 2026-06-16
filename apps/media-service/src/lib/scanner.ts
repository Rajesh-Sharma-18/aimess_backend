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
import Queue from "bull";
import type { Queue as BullQueue, Job } from "bull";
import type { Redis } from "@aimess/redis";

import { logger } from "@aimess/logger";
import { getObjectBytes, deleteObject } from "@aimess/storage";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { storageClient } from "../config/storage.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Lifecycle status for an uploaded object:
 *   PENDING    → confirm called, scan in progress
 *   CLEAN      → all checks passed; file is downloadable
 *   INFECTED   → virus detected by AV scanner
 *   QUARANTINED → rejected by magic-byte / ZIP checks or after INFECTED
 *   SKIPPED    → no-op scanner active (dev mode); file accessible but unscanned
 *   ERROR      → scanner error; confirm should be retried
 */
export type MediaScanStatus =
  | "PENDING"
  | "CLEAN"
  | "INFECTED"
  | "QUARANTINED"
  | "SKIPPED"
  | "ERROR";

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
      redis: { host: env.BULL_REDIS_HOST, port: env.BULL_REDIS_PORT },
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

  if (result.status === "INFECTED") {
    logger.error("media-scan: INFECTED — quarantining", {
      objectKey,
      signature: result.details,
    });
    await scanStatusStore.set(objectKey, "QUARANTINED");
    await deleteObject(storageClient, bucket, objectKey);
    return "QUARANTINED";
  }

  if (result.status === "ERROR") {
    logger.warn("media-scan: scanner ERROR — leaving PENDING for retry", {
      objectKey,
      detail: result.details,
    });
    return "PENDING";
  }

  // CLEAN or SKIPPED → downloadable
  await scanStatusStore.set(objectKey, "CLEAN");
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
        objectKey: job.data.objectKey,
        error: err?.message,
      });
      void scanStatusStore.set(job.data.objectKey, "ERROR");
    }
  });

  logger.info(
    `media-scan worker started (concurrency=${env.MEDIA_SCAN_CONCURRENCY})`
  );
}
