import { randomUUID } from "node:crypto";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import type {
  DeviceLinkDeviceInfo,
  DeviceLinkRecord,
  DeviceLinkState,
} from "../types/device-link.types.js";

/** QR link sessions are short-lived: 60s to scan (spec). */
const LINK_TTL_SECONDS = env.QR_LINK_TTL_SECONDS;

/**
 * The Redis key survives a bit past `expiresAt` so the scheduler-driven sweeper
 * (jobs/qr-link-expiry-sweeper.ts) can still SCAN and find it after its logical
 * expiry, before Redis's own TTL garbage-collects it. The claim/finalize calls
 * additionally check `expiresAt` themselves, so a record surviving in this
 * grace window can never be logged into.
 */
const REDIS_KEY_TTL_SECONDS =
  LINK_TTL_SECONDS + env.QR_LINK_SWEEP_GRACE_SECONDS;

const SCAN_PATTERN = "aimess:devlink:*";

function linkKey(linkToken: string): string {
  return `aimess:devlink:${linkToken}`;
}

/** QR token: UUID v4, per spec. Never put anything else in the QR content. */
function generateLinkToken(): string {
  return randomUUID();
}

/**
 * Claim atomically: only a PENDING, non-expired record may be claimed. This
 * is the exclusivity guarantee — if two requests race to log in with the same
 * QR, only one wins the PENDING → SCANNED flip; the other gets 'ALREADY'.
 * Records who claimed it (ARGV[1] = userId) purely for audit/defensive
 * purposes — the finalize call below always runs with the same userId in the
 * same request.
 */
const CLAIM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_FOUND' end
local rec = cjson.decode(raw)
if rec.expiresAt <= ARGV[2] then return 'EXPIRED' end
if rec.state ~= 'PENDING' then return 'ALREADY' end
rec.state = 'SCANNED'
rec.scannedAt = ARGV[2]
rec.scannedByUserId = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
return 'OK'
`;

/**
 * Finalize atomically: requires the record to be SCANNED (i.e. just claimed
 * by this same call), non-expired, by the SAME user — then flips straight to
 * USED (terminal, single-use). No intermediate "approved but not yet
 * collected" state and no tokens stored in Redis: the caller already has the
 * freshly-issued tokens in memory and returns/emits them directly.
 */
const FINALIZE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_FOUND' end
local rec = cjson.decode(raw)
if rec.expiresAt <= ARGV[1] then return 'EXPIRED' end
if rec.state == 'PENDING' then return 'NOT_SCANNED' end
if rec.state ~= 'SCANNED' then return 'ALREADY' end
if rec.scannedByUserId ~= ARGV[2] then return 'WRONG_USER' end
rec.state = 'USED'
rec.usedAt = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
return 'OK'
`;

/**
 * Sweeper claim: atomically flips a still-PENDING/SCANNED, past-expiry record
 * to EXPIRED and shortens its TTL to a small cleanup window. Multi-instance
 * safe — only ONE sweeper tick (across however many auth-service replicas are
 * running) observes 'OK' for a given key; every other replica's concurrent
 * attempt on the same key sees a state that is no longer PENDING/SCANNED and
 * gets 'ALREADY', so `auth:qr:expired` is published exactly once.
 */
const MARK_EXPIRED_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_FOUND' end
local rec = cjson.decode(raw)
if rec.expiresAt > ARGV[1] then return 'NOT_YET' end
if rec.state ~= 'PENDING' and rec.state ~= 'SCANNED' then return 'ALREADY' end
rec.state = 'EXPIRED'
redis.call('SET', KEYS[1], cjson.encode(rec), 'EX', 10)
return 'OK'
`;

export async function createLinkSession(
  device: DeviceLinkDeviceInfo
): Promise<{ linkToken: string; expiresAt: string }> {
  const linkToken = generateLinkToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + LINK_TTL_SECONDS * 1000);

  const record: DeviceLinkRecord = {
    state: "PENDING",
    device,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await redis.set(
    linkKey(linkToken),
    JSON.stringify(record),
    "EX",
    REDIS_KEY_TTL_SECONDS,
    "NX"
  );

  return { linkToken, expiresAt: expiresAt.toISOString() };
}

/** Old records may still say "CONSUMED" (pre-rename); normalize on read. */
function normalizeState(state: string): DeviceLinkState | "EXPIRED" {
  return state === "CONSUMED" ? "USED" : (state as DeviceLinkState | "EXPIRED");
}

export async function getLinkSession(
  linkToken: string
): Promise<DeviceLinkRecord | null> {
  const raw = await redis.get(linkKey(linkToken));
  if (!raw) return null;
  const record = JSON.parse(raw) as DeviceLinkRecord;
  return { ...record, state: normalizeState(record.state) as DeviceLinkState };
}

export async function claimLinkSessionAtomic(
  linkToken: string,
  userId: string
): Promise<"OK" | "NOT_FOUND" | "ALREADY" | "EXPIRED"> {
  const result = (await redis.eval(
    CLAIM_SCRIPT,
    1,
    linkKey(linkToken),
    userId,
    new Date().toISOString()
  )) as string;

  return result as "OK" | "NOT_FOUND" | "ALREADY" | "EXPIRED";
}

export async function finalizeLoginAtomic(
  linkToken: string,
  userId: string
): Promise<
  "OK" | "NOT_FOUND" | "ALREADY" | "NOT_SCANNED" | "WRONG_USER" | "EXPIRED"
> {
  const result = (await redis.eval(
    FINALIZE_SCRIPT,
    1,
    linkKey(linkToken),
    new Date().toISOString(),
    userId
  )) as string;

  return result as
    | "OK"
    | "NOT_FOUND"
    | "ALREADY"
    | "NOT_SCANNED"
    | "WRONG_USER"
    | "EXPIRED";
}

/**
 * SCAN (not KEYS — non-blocking, cursor-paged) every live device-link key.
 * Used only by the expiry sweeper's periodic tick; O(keys), fine at this
 * volume (each key lives at most ~90s).
 */
export async function scanLiveLinkTokens(): Promise<string[]> {
  const tokens: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      SCAN_PATTERN,
      "COUNT",
      200
    );
    cursor = next;
    for (const key of keys) {
      tokens.push(key.replace("aimess:devlink:", ""));
    }
  } while (cursor !== "0");
  return tokens;
}

/**
 * Atomically claim a past-expiry PENDING/SCANNED session as EXPIRED. Called by
 * the sweeper for each candidate key; multi-instance safe (see MARK_EXPIRED_SCRIPT).
 */
export async function markExpiredAtomic(
  linkToken: string
): Promise<"OK" | "NOT_FOUND" | "ALREADY" | "NOT_YET"> {
  const result = (await redis.eval(
    MARK_EXPIRED_SCRIPT,
    1,
    linkKey(linkToken),
    new Date().toISOString()
  )) as string;

  return result as "OK" | "NOT_FOUND" | "ALREADY" | "NOT_YET";
}
