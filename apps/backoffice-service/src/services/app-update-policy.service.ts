import { logger } from "@aimess/logger";
import { publishAppUpdatePolicy, type AppUpdatePolicy } from "@aimess/redis";

import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import { redis } from "../config/redis.js";
import { AUDIT_ACTIONS } from "../constants/index.js";
import type { AppUpdatePolicyInput } from "../api/validators/index.js";
import { auditService } from "./audit.service.js";

type RequestCtx = { ip: string; userAgent: string | null };

const asJson = (policy: AppUpdatePolicy) =>
  policy as unknown as Prisma.InputJsonValue;

const SETTING_KEY = "app.update.policy";

export type AppUpdatePolicyView = AppUpdatePolicy & {
  /** True until an admin has saved once; the gateway is still on its static config. */
  isDefault: boolean;
};

// Shown before the first save. Nothing is published for it, so the gateway keeps
// serving its own static file/env policy until an admin decides.
const DEFAULT_POLICY: AppUpdatePolicy = {
  android: {
    mode: "STORE_MANAGED",
    forceBelowVersion: null,
    blockedVersions: [],
    latestVersion: "1.0.0",
    fullyRolledOut: true,
    minOsLevel: null,
    storeUrl: null,
    enforceOnServer: false,
    copy: {},
    store: { forceFromPriority: 4, softFromPriority: 2, escalateSoftAfterDays: null },
  },
  ios: {
    mode: "STORE_MANAGED",
    forceBelowVersion: null,
    blockedVersions: [],
    latestVersion: "1.0.0",
    fullyRolledOut: true,
    minOsLevel: null,
    storeUrl: null,
    enforceOnServer: false,
    copy: {},
    store: { appStoreId: null, forceOnBump: "OFF", softOnBump: "OFF" },
  },
  policyVersion: 0,
  updatedAt: new Date(0).toISOString(),
};

async function readStored(): Promise<AppUpdatePolicy | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
  return row ? (row.value as unknown as AppUpdatePolicy) : null;
}

export const appUpdatePolicyService = {
  async get(): Promise<AppUpdatePolicyView> {
    const stored = await readStored();
    return stored ? { ...stored, isDefault: false } : { ...DEFAULT_POLICY, isDefault: true };
  },

  /**
   * Replace the whole policy (both platforms). The SystemSetting row is the durable
   * copy and is written first; Redis is the hot copy every gateway node reads, and
   * is re-published on boot, so a Redis failure here self-heals on restart. The
   * request still fails in that case: the admin must not be told a change is live
   * when gateways can't see it yet.
   */
  async set(
    input: AppUpdatePolicyInput,
    actorId: string,
    ctx: RequestCtx
  ): Promise<AppUpdatePolicyView> {
    const before = await readStored();
    const policy: AppUpdatePolicy = {
      ...input,
      policyVersion: (before?.policyVersion ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };

    await prisma.systemSetting.upsert({
      where: { key: SETTING_KEY },
      update: { value: asJson(policy), updatedById: actorId },
      create: { key: SETTING_KEY, value: asJson(policy), updatedById: actorId },
    });

    await publishAppUpdatePolicy(redis, policy);

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.SYSTEM_APP_UPDATE_POLICY_UPDATED,
      targetType: "settings",
      targetId: SETTING_KEY,
      before: before ? asJson(before) : undefined,
      after: asJson(policy),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { ...policy, isDefault: false };
  },

  /** Boot-time re-publish of the durable copy, so a flushed Redis can't drop the policy. */
  async publishStored(): Promise<void> {
    const stored = await readStored();
    if (!stored) return;
    await publishAppUpdatePolicy(redis, stored);
    logger.info(`App update policy v${stored.policyVersion} published to Redis`);
  },
};
