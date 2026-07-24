import { logger } from "@aimess/logger";

import { prisma } from "../config/prisma.js";
import { chatClient, type AdminCallingEnabled } from "../grpc/chat.client.js";
import { userClient } from "../grpc/user.client.js";
import { auditService } from "./audit.service.js";
import { AUDIT_ACTIONS } from "../constants/index.js";

type RequestCtx = { ip: string; userAgent: string | null };

export type DisconnectAllFriendshipsResult = {
  friendshipsDisconnected: number;
  usersAffected: number;
};

/** `SystemSetting` key mirroring chat-service's authoritative calling flag. */
const CALLING_SETTING_KEY = "feature.calling.enabled";

export const systemMaintenanceService = {
  /**
   * Platform-wide unfriend sweep — force-unfriends EVERY accepted friendship
   * on the platform via `UserService.AdminDisconnectAllFriendships`. Gated by
   * the route to SUPER_ADMIN's `settings.manage` permission; this is the ONE
   * call site for that RPC, so accountability lives here: always writes an
   * AuditLog row with the actor + resulting counts before returning.
   *
   * `confirm: true` is required by both this route's validator and the RPC
   * itself — a client can never trigger this by omission.
   */
  async disconnectAllFriendships(
    actorId: string,
    ctx: RequestCtx
  ): Promise<DisconnectAllFriendshipsResult> {
    const result = await userClient.adminDisconnectAllFriendships(true);

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.SYSTEM_ALL_FRIENDSHIPS_DISCONNECTED,
      targetType: "platform",
      targetId: "all_friendships",
      after: {
        friendshipsDisconnected: result.friendshipsDisconnected,
        usersAffected: result.usersAffected,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return result;
  },

  /** Current state of the platform-wide calling kill-switch. */
  getCallingEnabled(): Promise<AdminCallingEnabled> {
    return chatClient.adminGetCallingEnabled();
  },

  /**
   * Flip the platform-wide calling kill-switch.
   *
   * chat-service is the AUTHORITATIVE store (it owns the enforcement point in
   * `initiateCall`), so we set it there first and only record locally once that
   * succeeds — a failed RPC must not leave the admin panel claiming a state the
   * platform isn't in. The local `SystemSetting` row and the AuditLog are the
   * admin-side trail: who flipped it, when.
   *
   * Disabling blocks only NEW calls; calls already connected keep running.
   */
  async setCallingEnabled(
    enabled: boolean,
    actorId: string,
    ctx: RequestCtx
  ): Promise<AdminCallingEnabled> {
    const result = await chatClient.adminSetCallingEnabled(enabled, actorId);

    // Mirror + audit are best-effort bookkeeping — never fail the request after
    // the authoritative flip already landed.
    try {
      await prisma.systemSetting.upsert({
        where: { key: CALLING_SETTING_KEY },
        update: { value: { enabled: result.enabled }, updatedById: actorId },
        create: {
          key: CALLING_SETTING_KEY,
          value: { enabled: result.enabled },
          updatedById: actorId,
        },
      });
    } catch (error) {
      logger.warn(
        `systemMaintenance|failed to mirror ${CALLING_SETTING_KEY}: ${String(error)}`
      );
    }

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.SYSTEM_CALLING_TOGGLED,
      targetType: "platform",
      targetId: "calling",
      after: { enabled: result.enabled },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return result;
  },
};
