import { randomBytes } from "node:crypto";

import { redis } from "../config/redis.js";
import type {
  DeviceLinkDeviceInfo,
  DeviceLinkRecord,
  DeviceLinkState,
} from "../types/device-link.types.js";
import type { AuthTokens } from "./token.js";
import { hashToken } from "./token.js";

/** QR link sessions are short-lived: 2 minutes to scan + approve. */
const LINK_TTL_SECONDS = 120;

function linkKey(linkToken: string): string {
  return `aimess:devlink:${linkToken}`;
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Approve atomically: GET record, reject if missing/already-approved, else flip
 * to APPROVED with tokens + label and re-SET with KEEPTTL. Single-use guarantee
 * lives in Redis so two approvers cannot both mint tokens.
 */
const APPROVE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_FOUND' end
local rec = cjson.decode(raw)
if rec.state ~= 'PENDING' then return 'ALREADY' end
rec.state = 'APPROVED'
rec.tokens = cjson.decode(ARGV[1])
rec.approvedAt = ARGV[2]
rec.approvedDeviceLabel = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
return 'OK'
`;

/**
 * Consume atomically: only an APPROVED record yields tokens, and the same call
 * flips it to CONSUMED + strips tokens so the polling device receives them once.
 * Returns the current state plus tokens (only on the APPROVED→CONSUMED edge).
 */
const CONSUME_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ state = 'EXPIRED', tokens = false, label = false }) end
local rec = cjson.decode(raw)
if rec.state == 'APPROVED' then
  local tokens = rec.tokens
  local label = rec.approvedDeviceLabel
  rec.state = 'CONSUMED'
  rec.tokens = nil
  rec.consumedAt = ARGV[1]
  redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
  return cjson.encode({ state = 'CONSUMED', tokens = tokens, label = label })
end
return cjson.encode({ state = rec.state, tokens = false, label = rec.approvedDeviceLabel })
`;

export async function createLinkSession(
  device: DeviceLinkDeviceInfo
): Promise<{ linkToken: string; pollSecret: string; expiresAt: string }> {
  const linkToken = generateToken();
  const pollSecret = generateToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + LINK_TTL_SECONDS * 1000);

  const record: DeviceLinkRecord = {
    state: "PENDING",
    pollSecretHash: hashToken(pollSecret),
    device,
    createdAt: createdAt.toISOString(),
  };

  await redis.set(
    linkKey(linkToken),
    JSON.stringify(record),
    "EX",
    LINK_TTL_SECONDS,
    "NX"
  );

  return { linkToken, pollSecret, expiresAt: expiresAt.toISOString() };
}

export async function getLinkSession(
  linkToken: string
): Promise<DeviceLinkRecord | null> {
  const raw = await redis.get(linkKey(linkToken));
  if (!raw) return null;
  return JSON.parse(raw) as DeviceLinkRecord;
}

export async function approveLinkSessionAtomic(
  linkToken: string,
  tokens: AuthTokens,
  approvedDeviceLabel: string | null
): Promise<"OK" | "NOT_FOUND" | "ALREADY"> {
  const result = (await redis.eval(
    APPROVE_SCRIPT,
    1,
    linkKey(linkToken),
    JSON.stringify(tokens),
    new Date().toISOString(),
    approvedDeviceLabel ?? ""
  )) as string;

  return result as "OK" | "NOT_FOUND" | "ALREADY";
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
    state: DeviceLinkState | "EXPIRED";
    tokens: AuthTokens | false;
    label: string | false;
  };

  return {
    state: parsed.state,
    approvedDeviceLabel: parsed.label === false ? null : parsed.label,
    tokens: parsed.tokens === false ? null : parsed.tokens,
  };
}
