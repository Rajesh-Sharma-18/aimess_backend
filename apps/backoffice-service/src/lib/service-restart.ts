import { readFile } from "node:fs/promises";

import { env } from "../config/env.js";
import type { ServiceHealth } from "../types/system-health.types.js";

/**
 * Service restart — WHICH services may be restarted, WHETHER a restart could
 * help, and the one call that asks the restart agent to do it.
 *
 *   admin panel → backoffice (auth, RBAC, allowlist, lock, cooldown, audit)
 *     → restart agent (deploy/restart-agent: internal network only, bearer
 *       token, its own allowlist)
 *       → Docker Engine API → that one container
 *
 * Backoffice never holds the Docker socket and never sends a command — only an
 * allowlisted service id. See deploy/dev02/compose.restart-agent.yml.
 */

/**
 * System Health service key → the compose service the agent restarts.
 * Deliberately absent:
 *   - backoffice-service: it serves this API and runs the health verification;
 *     restarting it kills the request and the check that would confirm success.
 *   - api-gateway: every admin request, including this one, passes through it.
 *   - calls: Calling runs inside chat-service — restart Chat Service instead.
 */
export const RESTARTABLE_SERVICES: ReadonlyMap<string, string> = new Map([
  ["auth", "auth-service"],
  ["user", "user-service"],
  ["community", "community-service"],
  ["chat", "chat-service"],
  ["media", "media-service"],
  ["notification", "notifications-service"],
  ["stream", "stream-service"],
]);

/** Held from request to verified outcome; System Health reads it as "restarting". */
export const restartLockKey = (serviceKey: string): string =>
  `backoffice:service-restart:lock:${serviceKey}`;

export const RESTARTABLE_KEYS = [...RESTARTABLE_SERVICES.keys()] as [
  string,
  ...string[],
];

export type RestartAction =
  | "none"
  | "restart"
  | "investigate_dependency"
  | "investigate";

export interface RestartAdvice {
  action: RestartAction;
  /** The component(s) whose failure explains the service's status. */
  affectedComponents: string[];
}

/**
 * Could restarting this service reasonably fix its current health? Only when
 * its OWN endpoint is failing while every dependency it uses is healthy. A
 * failing dependency (MinIO down, MongoDB timing out) is still failing after
 * the restart — and a service crash-looping on it keeps crashing — so the
 * advice is to investigate that dependency, never to restart the service.
 */
export function restartAdvice(row: ServiceHealth | undefined): RestartAdvice {
  if (!row || row.status === "healthy") {
    return { action: "none", affectedComponents: [] };
  }
  const [own, ...dependencies] = row.checks ?? [];
  const failing = dependencies.filter((c) => c.status !== "healthy");
  if (failing.length > 0) {
    return {
      action: "investigate_dependency",
      affectedComponents: failing.map((c) => c.name),
    };
  }
  if (own && (own.status === "down" || own.status === "degraded")) {
    return { action: "restart", affectedComponents: [row.name] };
  }
  return { action: "investigate", affectedComponents: [] };
}

/** Docker's stop grace (10s) plus container start, with headroom. */
const AGENT_TIMEOUT_MS = 45_000;

/** Restart is available only where an agent was deployed and wired in. */
export function isRestartAgentConfigured(): boolean {
  return Boolean(
    env.SERVICE_RESTART_AGENT_URL && env.SERVICE_RESTART_AGENT_TOKEN_FILE
  );
}

/**
 * Ask the agent to restart one allowlisted compose service. Resolves once the
 * agent reports Docker's restart returned; rejects on anything else. It does
 * NOT mean the service is healthy — the caller verifies that separately.
 */
export async function requestAgentRestart(service: string): Promise<void> {
  const base = env.SERVICE_RESTART_AGENT_URL;
  const tokenFile = env.SERVICE_RESTART_AGENT_TOKEN_FILE;
  if (!base || !tokenFile) throw new Error("restart agent is not configured");

  // Read per call (a compose secret file), so a rotated token needs no restart.
  const token = (await readFile(tokenFile, "utf8")).trim();
  const res = await fetch(new URL("/v1/restart", base), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ service }),
    redirect: "error",
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`restart agent answered HTTP ${String(res.status)}`);
  }
}
