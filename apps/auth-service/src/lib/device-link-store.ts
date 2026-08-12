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

/**
 * Secondary index: maps a device fingerprint (the caller's opaque clientId
 * where available — see deviceLinkService.initiate) to the most-recently-created
 * PENDING QR linkToken for that device. Written atomically alongside the main
 * QR record in `createLinkSession`, deleted when the session is cancelled,
 * used, or expired. Allows "replace prior session" without a full SCAN.
 *
 * TTL intentionally matches the main record's extended TTL so the index never
 * outlives the record it points to.
 */
function fingerprintKey(fingerprint: string): string {
  return `aimess:devlink:fp:${fingerprint}`;
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
 *
 * Also removes the fingerprint pointer so a fresh QR can be created
 * immediately on the same device after a successful scan.
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
if ARGV[3] ~= '' then
  local fp_key = ARGV[3]
  local current = redis.call('GET', fp_key)
  if current == KEYS[1]:sub(16) then
    redis.call('DEL', fp_key)
  end
end
return 'OK'
`;

/**
 * Sweeper claim: atomically flips a still-PENDING/SCANNED, past-expiry record
 * to EXPIRED and shortens its TTL to a small cleanup window. Multi-instance
 * safe — only ONE sweeper tick (across however many auth-service replicas are
 * running) observes 'OK' for a given key; every other replica's concurrent
 * attempt on the same key sees a state that is no longer PENDING/SCANNED and
 * gets 'ALREADY', so `auth:qr:expired` is published exactly once.
 *
 * CANCELLED sessions are already terminal — they are skipped (returns 'ALREADY')
 * so no duplicate `auth:qr:expired` is emitted for a superseded session.
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

/**
 * Cancel atomically: atomically flips a PENDING session to CANCELLED (terminal).
 * Used when the same device generates a new QR — the old session is superseded
 * instantly so the waiting browser tab can be told immediately via
 * `auth:qr:cancelled`, and the old token can never be scanned into.
 *
 * Only PENDING sessions are cancellable — a SCANNED session is mid-login and
 * must not be interrupted; the result 'IN_PROGRESS' tells the caller to leave
 * it alone and let the login complete or expire naturally.
 *
 * KEYS[1] = aimess:devlink:{oldLinkToken}
 * ARGV[1] = ISO timestamp (cancelledAt)
 */
const CANCEL_SESSION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_FOUND' end
local rec = cjson.decode(raw)
if rec.state == 'SCANNED' then return 'IN_PROGRESS' end
if rec.state ~= 'PENDING' then return 'ALREADY' end
rec.state = 'CANCELLED'
rec.cancelledAt = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(rec), 'EX', 10)
return 'OK'
`;

/**
 * Create a new QR link session, automatically superseding any prior PENDING
 * session from the same device (identified by `fingerprint`, the sha256 of
 * userAgent + IP captured in `buildSessionContext`).
 *
 * Returns the new linkToken/expiresAt plus — if a prior session was cancelled —
 * the old linkToken so the service layer can publish `auth:qr:cancelled` to
 * the old browser tab. The caller MUST publish the cancel event; this function
 * only updates Redis state.
 *
 * WhatsApp-like guarantee: one active QR per device. Rapid re-generation from
 * the same browser (refresh, multiple tabs) never accumulates stale PENDING
 * sessions and can never trigger the IP-based rate limiter through normal
 * browser behaviour.
 */
export async function createLinkSession(
  device: DeviceLinkDeviceInfo,
  /** Per-browser index key; see deviceLinkService.initiate for how it's derived. */
  fingerprint: string
): Promise<{
  linkToken: string;
  expiresAt: string;
  cancelledToken: string | null;
}> {
  const fpKey = fingerprintKey(fingerprint);

  // ── Step 1: Atomically cancel any prior PENDING session for this device. ──
  // Look up the fingerprint pointer; if it points to a live PENDING session,
  // cancel it. The cancel Lua script is atomic — a concurrent scan/login on
  // the old token is either already SCANNED (IN_PROGRESS → we skip) or wins
  // the PENDING → CANCELLED flip before us (NOT_FOUND/ALREADY → we skip).
  let cancelledToken: string | null = null;

  const priorToken = await redis.get(fpKey);
  if (priorToken) {
    const cancelResult = (await redis.eval(
      CANCEL_SESSION_SCRIPT,
      1,
      linkKey(priorToken),
      new Date().toISOString()
    )) as string;

    if (cancelResult === "OK") {
      cancelledToken = priorToken;
    }
    // IN_PROGRESS: a scan is happening on the old QR right now — don't disrupt
    // it. Leave the fingerprint pointer; the FINALIZE_SCRIPT will clean it up.
    // NOT_FOUND / ALREADY: already gone — clean up the stale pointer.
    if (cancelResult !== "IN_PROGRESS") {
      await redis.del(fpKey);
    }
  }

  // ── Step 2: Create the new session and write the fingerprint pointer. ──
  const linkToken = generateLinkToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + LINK_TTL_SECONDS * 1000);

  const record: DeviceLinkRecord = {
    state: "PENDING",
    device,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  // Pipeline: write the QR record + fingerprint index together. We intentionally
  // use SET without NX here (unlike the old code) because the UUID guarantees
  // uniqueness and we've already cancelled the prior session above. The
  // fingerprint pointer overwrites any stale entry (e.g. a cancelled token we
  // just cleaned up) in one atomic step.
  await redis
    .multi()
    .set(
      linkKey(linkToken),
      JSON.stringify(record),
      "EX",
      REDIS_KEY_TTL_SECONDS
    )
    .set(fpKey, linkToken, "EX", REDIS_KEY_TTL_SECONDS)
    .exec();

  return { linkToken, expiresAt: expiresAt.toISOString(), cancelledToken };
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
  userId: string,
  /** Fingerprint key so it can be cleaned up atomically on success. */
  fingerprintKeyArg?: string
): Promise<
  "OK" | "NOT_FOUND" | "ALREADY" | "NOT_SCANNED" | "WRONG_USER" | "EXPIRED"
> {
  const result = (await redis.eval(
    FINALIZE_SCRIPT,
    1,
    linkKey(linkToken),
    new Date().toISOString(),
    userId,
    fingerprintKeyArg ?? ""
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
 *
 * Fingerprint index keys (`aimess:devlink:fp:*`) are intentionally excluded
 * — only the main session records (`aimess:devlink:<uuid>`) are swept.
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
      const suffix = key.replace("aimess:devlink:", "");
      // Only bare `aimess:devlink:<uuid>` records are sweepable. Every other
      // key under this prefix is a sidecar with a namespaced suffix — the
      // fingerprint index (`fp:<hash>`) and the one-shot success mailbox
      // (`result:<uuid>`, written by publishQrLinkSuccess). Feeding either to
      // MARK_EXPIRED_SCRIPT makes its cjson.decode yield a record with no
      // `expiresAt`, and the Lua comparison against nil throws — aborting the
      // whole sweep tick, so nothing expires while a mailbox key is alive.
      if (suffix.includes(":")) continue;
      tokens.push(suffix);
    }
  } while (cursor !== "0");
  return tokens;
}

/**
 * Atomically claim a past-expiry PENDING/SCANNED session as EXPIRED. Called by
 * the sweeper for each candidate key; multi-instance safe (see MARK_EXPIRED_SCRIPT).
 * CANCELLED sessions are skipped by the script (returns 'ALREADY').
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
