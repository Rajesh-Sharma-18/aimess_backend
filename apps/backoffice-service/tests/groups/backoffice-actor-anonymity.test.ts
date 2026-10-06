/**
 * Who a backoffice group removal is attributed to, on the wire.
 *
 * Members read a Backoffice removal as "Administrator removed X"; the acting
 * admin's name must never leave admin_db. So the RPC carries the admin's id
 * (recorded as GroupMember.kickedBy, and in the audit row) and nothing else.
 *
 * Unlike group-management.test.ts this file deliberately does NOT mock
 * `groupService`, so the service and repository run for real up to the client.
 */
jest.mock("../../src/repositories/index.js", () => {
  const actual = jest.requireActual("../../src/repositories/index.js");
  return {
    __esModule: true,
    ...actual,
    adminUserRepository: { findById: jest.fn() },
  };
});
jest.mock("../../src/lib/admin-perms-cache.js", () => ({
  getCachedAdminPermissions: jest.fn(async () => [] as string[]),
  invalidateAdminPermissions: jest.fn(async () => undefined),
}));

const adminRemoveGroupMember = jest.fn(async () => ({
  ok: true,
  found: true,
  errorCode: "",
}));
jest.mock("../../src/grpc/chat.client.js", () => ({
  chatClient: { adminRemoveGroupMember },
}));

const record = jest.fn(async () => ({ id: "audit-1" }));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const GID = "grp_001";
const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  jest.clearAllMocks();
  configureActiveAdmin(findById, { name: "Super Admin" });
  grantPermissions(perms, [
    PERMISSIONS.GROUPS_READ,
    PERMISSIONS.GROUPS_MODERATE,
  ]);
});

describe("POST /v1/groups/:groupId/members/:userId/remove — actor attribution", () => {
  it("POSITIVE: forwards the acting admin's id, never their name", async () => {
    const res = await request(app)
      .post(`/v1/groups/${GID}/members/u1/remove`)
      .set(auth())
      .send({ reason: "harassment" });

    expect(res.status).toBe(200);
    expect(adminRemoveGroupMember).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: GID,
        userId: "u1",
        reason: "harassment",
      })
    );
    // The id travels — it is what `GroupMember.kickedBy` records.
    const req = adminRemoveGroupMember.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(req.actorAdminId).toBeTruthy();
    expect(req).not.toHaveProperty("actorAdminName");
    expect(JSON.stringify(req)).not.toContain("Super Admin");
    // The audit row keeps the real admin identity.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: req.actorAdminId })
    );
  });

  it("NEGATIVE: an unauthorized caller sends nothing at all", async () => {
    grantPermissions(perms, [PERMISSIONS.GROUPS_READ]);

    const res = await request(app)
      .post(`/v1/groups/${GID}/members/u1/remove`)
      .set(auth())
      .send({});

    expect(res.status).toBe(403);
    expect(adminRemoveGroupMember).not.toHaveBeenCalled();
  });
});
