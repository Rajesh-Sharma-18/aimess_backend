/**
 * systemMaintenanceService.disconnectAllFriendships — the ONE call site for
 * the platform-wide unfriend sweep gRPC RPC. Asserts it always forces
 * `confirm: true` on the gRPC call and always writes an AuditLog row with the
 * actor + resulting counts before returning, so there is no way to reach the
 * gRPC layer without an audit trail.
 */
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: {
    adminDisconnectAllFriendships: jest.fn(),
  },
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: {
    record: jest.fn(async () => undefined),
  },
}));

import { systemMaintenanceService } from "../../src/services/system-maintenance.service.js";
import { userClient } from "../../src/grpc/user.client.js";
import { auditService } from "../../src/services/audit.service.js";
import { AUDIT_ACTIONS } from "../../src/constants/index.js";

const grpc = userClient as unknown as {
  adminDisconnectAllFriendships: jest.Mock;
};
const audit = auditService as unknown as { record: jest.Mock };

const ACTOR_ID = "admin-1";
const CTX = { ip: "127.0.0.1", userAgent: "jest" };

describe("systemMaintenanceService.disconnectAllFriendships", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    grpc.adminDisconnectAllFriendships.mockResolvedValue({
      friendshipsDisconnected: 100,
      usersAffected: 60,
    });
  });

  it("always calls the gRPC client with confirm: true", async () => {
    await systemMaintenanceService.disconnectAllFriendships(ACTOR_ID, CTX);
    expect(grpc.adminDisconnectAllFriendships).toHaveBeenCalledWith(true);
  });

  it("writes an AuditLog row with the actor + resulting counts", async () => {
    await systemMaintenanceService.disconnectAllFriendships(ACTOR_ID, CTX);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ACTOR_ID,
        action: AUDIT_ACTIONS.SYSTEM_ALL_FRIENDSHIPS_DISCONNECTED,
        targetType: "platform",
        after: { friendshipsDisconnected: 100, usersAffected: 60 },
        ip: CTX.ip,
        userAgent: CTX.userAgent,
      })
    );
  });

  it("returns the gRPC result unchanged", async () => {
    const result = await systemMaintenanceService.disconnectAllFriendships(
      ACTOR_ID,
      CTX
    );
    expect(result).toEqual({
      friendshipsDisconnected: 100,
      usersAffected: 60,
    });
  });
});
