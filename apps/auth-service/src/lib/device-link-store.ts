import { randomBytes, randomUUID } from "node:crypto";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import type {
  DeviceLinkDeviceInfo,
  DeviceLinkRecord,
  DeviceLinkState,
} from "../types/device-link.types.js";
import type { AuthTokens } from "./token.js";
import { hashToken } from "./token.js";

/** QR link sessions are short-lived: 60s to scan + approve (spec). */
const LINK_TTL_SECONDS = env.QR_LINK_TTL_SECONDS;

/**
 * The Redis key survives a bit past `expiresAt` so the scheduler-driven sweeper
 * (jobs/qr-link-expiry-sweeper.ts) can still SCAN and find it after its logical
 * expiry, before Redis's own TTL garbage-collects it. All state transitions
 * (scan/approve/reject) additionally check `expiresAt` themselves, so a record
 * surviving in this grace window can never be scanned/approved/rejected.
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

/** Poll secret: a private value the initiating device keeps to itself — not spec'd as UUID. */
function generatePollSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Scan atomically: only a PENDING, non-expired record may be scanned. Records
 * who scanned it so approve/reject can later enforce "same approving user"
 * (ARGV[1] = userId).
 */
const SCAN_SCRIPT = `
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
 * Approve atomically: requires the record to be SCANNED, non-expired, by the
 * SAME user approving (ARGV[3] = approverUserId) before flipping to APPROVED
 * with tokens + label. Single-use guarantee lives in Redis so two approvers
 * cannot both mint tokens.
 */
const APPROVE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_FOUND' end
local rec = cjson.decode(raw)
if rec.expiresAt <= ARGV[2] then return 'EXPIRED' end
if rec.state == 'PENDING' then return 'NOT_SCANNED' end
if rec.state ~= 'SCANNED' then return 'ALREADY' end
if rec.scannedByUserId ~= ARGV[3] then return 'WRONG_USER' end
rec.state = 'APPROVED'
rec.tokens = cjson.decode(ARGV[1])
rec.approvedAt = ARGV[2]
rec.approvedDeviceLabel = ARGV[4]
redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
return 'OK'
`;

/** Reject atomically: same "scanned by the same user, not expired" guard as approve. */
const REJECT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_FOUND' end
local rec = cjson.decode(raw)
if rec.expiresAt <= ARGV[1] then return 'EXPIRED' end
if rec.state == 'PENDING' then return 'NOT_SCANNED' end
if rec.state ~= 'SCANNED' then return 'ALREADY' end
if rec.scannedByUserId ~= ARGV[2] then return 'WRONG_USER' end
rec.state = 'REJECTED'
rec.rejectedAt = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
return 'OK'
`;

/**
 * Consume atomically: only an APPROVED record yields tokens, and the same call
 * flips it to USED + strips tokens so the polling device receives them once.
 * Returns the current state plus tokens (only on the APPROVED→USED edge).
 */
const CONSUME_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ state = 'EXPIRED', tokens = false, label = false }) end
local rec = cjson.decode(raw)
if rec.state == 'APPROVED' then
  local tokens = rec.tokens
  local label = rec.approvedDeviceLabel
  rec.state = 'USED'
  rec.tokens = nil
  rec.usedAt = ARGV[1]
  redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
  return cjson.encode({ state = 'USED', tokens = tokens, label = label })
end
return cjson.encode({ state = rec.state, tokens = false, label = rec.approvedDeviceLabel })
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
): Promise<{ linkToken: string; pollSecret: string; expiresAt: string }> {
  const linkToken = generateLinkToken();
  const pollSecret = generatePollSecret();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + LINK_TTL_SECONDS * 1000);

  const record: DeviceLinkRecord = {
    state: "PENDING",
    pollSecretHash: hashToken(pollSecret),
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

  return { linkToken, pollSecret, expiresAt: expiresAt.toISOString() };
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

export async function scanLinkSessionAtomic(
  linkToken: string,
  scannedByUserId: string
): Promise<"OK" | "NOT_FOUND" | "ALREADY" | "EXPIRED"> {
  const result = (await redis.eval(
    SCAN_SCRIPT,
    1,
    linkKey(linkToken),
    scannedByUserId,
    new Date().toISOString()
  )) as string;

  return result as "OK" | "NOT_FOUND" | "ALREADY" | "EXPIRED";
}

export async function approveLinkSessionAtomic(
  linkToken: string,
  tokens: AuthTokens,
  approvedDeviceLabel: string | null,
  approverUserId: string
): Promise<
  "OK" | "NOT_FOUND" | "ALREADY" | "NOT_SCANNED" | "WRONG_USER" | "EXPIRED"
> {
  const result = (await redis.eval(
    APPROVE_SCRIPT,
    1,
    linkKey(linkToken),
    JSON.stringify(tokens),
    new Date().toISOString(),
    approverUserId,
    approvedDeviceLabel ?? ""
  )) as string;

  return result as
    | "OK"
    | "NOT_FOUND"
    | "ALREADY"
    | "NOT_SCANNED"
    | "WRONG_USER"
    | "EXPIRED";
}

export async function rejectLinkSessionAtomic(
  linkToken: string,
  rejectingUserId: string
): Promise<
  "OK" | "NOT_FOUND" | "ALREADY" | "NOT_SCANNED" | "WRONG_USER" | "EXPIRED"
> {
  const result = (await redis.eval(
    REJECT_SCRIPT,
    1,
    linkKey(linkToken),
    new Date().toISOString(),
    rejectingUserId
  )) as string;

  return result as
    | "OK"
    | "NOT_FOUND"
    | "ALREADY"
    | "NOT_SCANNED"
    | "WRONG_USER"
    | "EXPIRED";
}

export async function consumeTokensAtomic(linkToken: string): Promise<{
  state: DeviceLinkState | "EXPIRED";
  approvedDeviceLabel: string | null;
  tokens: AuthTokens | null;
}> {
  const raw = (await redis.eval(
    CONSUME_SCRIPT,
    1,
    linkKey(linkToken),
    new Date().toISOString()
  )) as string;

  const parsed = JSON.parse(raw) as {
    state: string;
    tokens: AuthTokens | false;
    label: string | false;
  };

  return {
    state: normalizeState(parsed.state),
    approvedDeviceLabel: parsed.label === false ? null : parsed.label,
    tokens: parsed.tokens === false ? null : parsed.tokens,
  };
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
