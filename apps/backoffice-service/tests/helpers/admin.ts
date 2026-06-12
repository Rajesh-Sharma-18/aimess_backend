/**
 * Shared helpers for AUTHENTICATED admin-route specs.
 *
 * The `adminAuth` middleware does three real things on every protected request:
 *   1. verify the admin access JWT  (real — mint with helpers/auth.ts),
 *   2. check the session is active  (global-mocks stubs this → true),
 *   3. load the admin via `adminUserRepository.findById` and require
 *      `status === "ACTIVE"`, then resolve permissions via
 *      `getCachedAdminPermissions`.
 *
 * Because the global Prisma client is an empty object, step 3 would throw unless
 * the test file mocks `adminUserRepository`. Each authed spec therefore:
 *   - `jest.mock("../../src/repositories/index.js", ...)` exposing `findById`,
 *   - imports `configureActiveAdmin` / `configureAdminStatus` from here to drive
 *     the loaded admin row, and
 *   - imports `grantPermissions` to set the permission set the route requires.
 */
import { TEST_ADMIN_ID } from "./auth.js";

/** The admin row shape `adminAuth` consumes (`admin.status`, `admin.role.key`). */
export function activeAdminRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: TEST_ADMIN_ID,
    email: "admin@aimess.local",
    name: "Admin One",
    avatarUrl: null,
    status: "ACTIVE",
    lastLoginAt: null,
    role: { key: "ADMIN" },
    ...overrides,
  };
}

/**
 * Point a mocked `adminUserRepository.findById` at an ACTIVE admin so the
 * middleware passes. Pass `status`/`role` overrides to exercise the gate.
 */
export function configureActiveAdmin(
  findById: jest.Mock,
  overrides: Record<string, unknown> = {}
): void {
  findById.mockResolvedValue(activeAdminRow(overrides));
}

/** Grant a set of permission keys to the resolved admin for this request. */
export function grantPermissions(
  getCachedAdminPermissions: jest.Mock,
  permissions: string[]
): void {
  getCachedAdminPermissions.mockResolvedValue(permissions);
}
