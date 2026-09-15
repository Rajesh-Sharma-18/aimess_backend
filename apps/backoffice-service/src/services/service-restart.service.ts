import { randomUUID } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";
import { AUDIT_ACTIONS } from "../constants/index.js";
import {
  isRestartAgentConfigured,
  requestAgentRestart,
  RESTARTABLE_SERVICES,
  restartAdvice,
  restartLockKey,
  type RestartAdvice,
} from "../lib/service-restart.js";
import type { ServiceHealthStatus } from "../types/system-health.types.js";
import { auditService } from "./audit.service.js";
import { systemHealthService } from "./system-health.service.js";

/**
 * Super Admin service restarts. State lives in Redis so every backoffice
 * instance — and a browser refreshed mid-restart — sees the same operation, and
 * the lock is what stops two admins (or a double click) restarting one service
 * at once.
 *
 *   requested   lock taken and audited; not yet sent to the agent
 *   restarting  sent to the agent; waiting for Docker's restart to return
 *   verifying   the container restarted; polling System Health
 *   succeeded   the service reported healthy within the deadline
 *   failed      the agent could not restart it, or health never recovered
 *
 * "Restart accepted", "restart completed" and "service healthy" are separate
 * states on purpose: only `succeeded` means the service is back.
 */

export type RestartStatus =
  | "requested"
  | "restarting"
  | "verifying"
  | "succeeded"
  | "failed";

export interface RestartOperation {
  id: string;
  serviceKey: string;
  serviceName: string;
  status: RestartStatus;
  previousStatus: ServiceHealthStatus;
  requestedAt: number;
  /** When the agent confirmed the container restarted. */
  restartedAt: number | null;
  completedAt: number | null;
  /** Health observed when the operation finished. */
  finalStatus: ServiceHealthStatus | null;
  /** Safe, human-readable reason — set when failed. */
  reason: string | null;
}

/** Audit context stays server-side; the client only ever sees RestartOperation. */
interface OperationRecord extends RestartOperation {
  adminId: string;
  requestId: string | null;
  ip: string;
  userAgent: string | null;
}

export interface ServiceRestartInfo {
  key: string;
  name: string;
  /** Can be restarted from the panel in this environment. */
  restartable: boolean;
  /** `environment`: no restart agent here. `manual`: never from the panel. */
  unavailableReason: "environment" | "manual" | null;
  advice: RestartAdvice;
  operation: RestartOperation | null;
  cooldownUntil: number | null;
}

export interface RestartContext {
  ip: string;
  userAgent: string | null;
  requestId: string | null;
}

export interface RestartTiming {
  pollIntervalMs: number;
  timeoutMs: number;
}

const DEFAULT_TIMING: RestartTiming = { pollIntervalMs: 5_000, timeoutMs: 60_000 };
/** No second restart of the same service within this window, success or not. */
const COOLDOWN_SEC = 300;
/** Outlives the agent timeout plus the health deadline, so a crashed run frees it. */
const LOCK_TTL_SEC = 180;
const OPERATION_TTL_SEC = 3_600;

const ACTIVE_STATUSES: ReadonlySet<RestartStatus> = new Set([
  "requested",
  "restarting",
  "verifying",
]);

const lockKey = restartLockKey;
const operationKey = (s: string): string => `backoffice:service-restart:op:${s}`;
const cooldownKey = (s: string): string =>
  `backoffice:service-restart:cooldown:${s}`;

const REASON_AGENT_FAILED = "The service manager could not restart the service.";
const REASON_INTERRUPTED = "The restart was interrupted before it finished.";
const unhealthyReason = (timeoutMs: number): string =>
  `Service restart was triggered, but the service did not become healthy within ${String(Math.round(timeoutMs / 1000))} seconds.`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

function toPublic(op: OperationRecord): RestartOperation {
  return {
    id: op.id,
    serviceKey: op.serviceKey,
    serviceName: op.serviceName,
    status: op.status,
    previousStatus: op.previousStatus,
    requestedAt: op.requestedAt,
    restartedAt: op.restartedAt,
    completedAt: op.completedAt,
    finalStatus: op.finalStatus,
    reason: op.reason,
  };
}

function auditPayload(op: OperationRecord) {
  return {
    service: RESTARTABLE_SERVICES.get(op.serviceKey) ?? op.serviceKey,
    previousStatus: op.previousStatus,
    result: op.status,
    requestedAt: iso(op.requestedAt),
    restartedAt: iso(op.restartedAt),
    completedAt: iso(op.completedAt),
    finalStatus: op.finalStatus,
    reason: op.reason,
    requestId: op.requestId,
    operationId: op.id,
  };
}

async function saveOperation(op: OperationRecord): Promise<void> {
  await redis.set(
    operationKey(op.serviceKey),
    JSON.stringify(op),
    "EX",
    OPERATION_TTL_SEC
  );
}

async function loadOperation(serviceKey: string): Promise<RestartOperation | null> {
  const raw = await redis.get(operationKey(serviceKey));
  if (!raw) return null;
  const op = JSON.parse(raw) as OperationRecord;
  // In flight, but its lock is gone: the backoffice instance running it died.
  if (
    ACTIVE_STATUSES.has(op.status) &&
    (await redis.get(lockKey(serviceKey))) !== op.id
  ) {
    return toPublic({
      ...op,
      status: "failed",
      reason: REASON_INTERRUPTED,
      completedAt: op.completedAt ?? op.requestedAt,
    });
  }
  return toPublic(op);
}

async function cooldownUntil(serviceKey: string): Promise<number | null> {
  const ttlMs = await redis.pttl(cooldownKey(serviceKey));
  return ttlMs > 0 ? Date.now() + ttlMs : null;
}

async function releaseLock(serviceKey: string, id: string): Promise<void> {
  // ponytail: get-then-del is not atomic; it only matters if the lock TTL
  // expired mid-run. Swap for a Lua compare-and-delete if that ever bites.
  if ((await redis.get(lockKey(serviceKey))) === id) {
    await redis.del(lockKey(serviceKey));
  }
}

async function finish(
  op: OperationRecord,
  status: "succeeded" | "failed",
  reason: string | null,
  finalStatus: ServiceHealthStatus | null
): Promise<void> {
  Object.assign(op, { status, reason, finalStatus, completedAt: Date.now() });
  await saveOperation(op);
  await redis.set(cooldownKey(op.serviceKey), "1", "EX", COOLDOWN_SEC);
  await releaseLock(op.serviceKey, op.id);
  try {
    await auditService.record({
      actorId: op.adminId,
      action: AUDIT_ACTIONS.SYSTEM_SERVICE_RESTART_COMPLETED,
      targetType: "service",
      targetId: RESTARTABLE_SERVICES.get(op.serviceKey) ?? op.serviceKey,
      after: auditPayload(op),
      ip: op.ip,
      userAgent: op.userAgent,
    });
  } catch (error) {
    logger.error(
      `service-restart|failed to audit completion of ${op.id}: ${String(error)}`
    );
  }
}

async function runRestart(op: OperationRecord, timing: RestartTiming): Promise<void> {
  const target = RESTARTABLE_SERVICES.get(op.serviceKey) ?? op.serviceKey;
  try {
    op.status = "restarting";
    await saveOperation(op);
    try {
      await requestAgentRestart(target);
    } catch (error) {
      logger.warn(`service-restart|agent could not restart ${target}: ${String(error)}`);
      await finish(op, "failed", REASON_AGENT_FAILED, null);
      return;
    }

    op.status = "verifying";
    op.restartedAt = Date.now();
    await saveOperation(op);

    const deadline = Date.now() + timing.timeoutMs;
    let observed: ServiceHealthStatus | null = null;
    while (Date.now() < deadline) {
      await sleep(timing.pollIntervalMs);
      const health = await systemHealthService.getSystemHealth();
      observed =
        health.services.find((s) => s.key === op.serviceKey)?.status ?? "unknown";
      // Fully healthy only — a service still degraded by a dependency is not fixed.
      if (observed === "healthy") {
        await finish(op, "succeeded", null, observed);
        return;
      }
    }
    await finish(op, "failed", unhealthyReason(timing.timeoutMs), observed);
  } catch (error) {
    logger.error(`service-restart|run ${op.id} crashed: ${String(error)}`);
    await finish(op, "failed", REASON_INTERRUPTED, null).catch(() => undefined);
  }
}

export const serviceRestartService = {
  /** Restart availability, advice and the latest operation for every monitored service. */
  async listRestarts(): Promise<{ enabled: boolean; services: ServiceRestartInfo[] }> {
    const health = await systemHealthService.getSystemHealth();
    const enabled = isRestartAgentConfigured();
    const services = await Promise.all(
      health.services.map(async (row): Promise<ServiceRestartInfo> => {
        const allowed = RESTARTABLE_SERVICES.has(row.key);
        const [operation, until] = allowed
          ? await Promise.all([loadOperation(row.key), cooldownUntil(row.key)])
          : [null, null];
        return {
          key: row.key,
          name: row.name,
          restartable: enabled && allowed,
          unavailableReason: !allowed ? "manual" : enabled ? null : "environment",
          advice: restartAdvice(row),
          operation,
          cooldownUntil: until,
        };
      })
    );
    return { enabled, services };
  },

  /**
   * Accept a restart and run it in the background. Refuses a key outside the
   * allowlist, an environment without an agent, a service in cooldown, one
   * already restarting, and one a restart would not fix.
   */
  async startRestart(
    serviceKey: string,
    adminId: string,
    ctx: RestartContext,
    timing: RestartTiming = DEFAULT_TIMING
  ): Promise<RestartOperation> {
    const target = RESTARTABLE_SERVICES.get(serviceKey);
    if (!target) throw new NotFoundError("ADMIN_SERVICE_RESTART_NOT_RESTARTABLE");
    if (!isRestartAgentConfigured()) {
      throw new ServiceUnavailableError("ADMIN_SERVICE_RESTART_UNSUPPORTED");
    }
    const until = await cooldownUntil(serviceKey);
    if (until !== null) {
      throw new TooManyRequestsError(
        "ADMIN_SERVICE_RESTART_COOLDOWN",
        Math.ceil((until - Date.now()) / 1000)
      );
    }

    const id = randomUUID();
    // The concurrency guard: a second admin, a double click or another
    // backoffice instance all lose this SET NX.
    const locked = await redis.set(lockKey(serviceKey), id, "EX", LOCK_TTL_SEC, "NX");
    if (locked !== "OK") throw new ConflictError("ADMIN_SERVICE_RESTART_IN_PROGRESS");

    try {
      const health = await systemHealthService.getSystemHealth();
      const row = health.services.find((s) => s.key === serviceKey);
      if (!row || restartAdvice(row).action !== "restart") {
        throw new ConflictError("ADMIN_SERVICE_RESTART_NOT_RECOMMENDED");
      }

      const op: OperationRecord = {
        id,
        serviceKey,
        serviceName: row.name,
        status: "requested",
        previousStatus: row.status,
        requestedAt: Date.now(),
        restartedAt: null,
        completedAt: null,
        finalStatus: null,
        reason: null,
        adminId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      };

      // Audited before anything happens, so a restart can never run unrecorded.
      await auditService.record({
        actorId: adminId,
        action: AUDIT_ACTIONS.SYSTEM_SERVICE_RESTART_REQUESTED,
        targetType: "service",
        targetId: target,
        before: { status: row.status },
        after: auditPayload(op),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await saveOperation(op);

      const accepted = toPublic(op);
      void runRestart(op, timing);
      return accepted;
    } catch (error) {
      await releaseLock(serviceKey, id);
      throw error;
    }
  },
};
