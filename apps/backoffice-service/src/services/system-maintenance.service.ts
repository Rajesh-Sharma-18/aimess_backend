import { userClient } from "../grpc/user.client.js";
import { auditService } from "./audit.service.js";
import { AUDIT_ACTIONS } from "../constants/index.js";

type RequestCtx = { ip: string; userAgent: string | null };

export type DisconnectAllFriendshipsResult = {
  friendshipsDisconnected: number;
  usersAffected: number;
};

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
};
