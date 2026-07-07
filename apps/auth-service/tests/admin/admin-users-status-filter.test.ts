/**
 * adminUsersRepository.adminListUsers — GET /admin/v1/users?status=... (via
 * backoffice → gRPC → this repository).
 *
 * Bug: `AuthUser.id` is a `@db.Uuid` column, but `userIds`/`excludeUserIds`
 * come from the backoffice `UserIndex` mirror (admin_db), which has NO
 * cross-DB FK to this table. Dev-seeded mirror rows use non-UUID ids like
 * "u_seed_29" (see apps/backoffice-service/prisma/seed/user-index.seed.ts) —
 * forwarding one of those straight into `id: { in/notIn: [...] }` makes
 * Postgres throw `PrismaClientKnownRequestError: invalid input syntax for
 * type uuid` instead of the query just matching zero rows for it.
 *
 * Fix: filter both id arrays to well-formed UUIDs before building the
 * `where` clause. This is behavior-preserving — a malformed id could never
 * have matched a real `AuthUser.id` anyway, so dropping it changes nothing
 * about which rows `in`/`notIn` select.
 */
const mockFindMany = jest.fn(async () => [] as unknown[]);
const mockCount = jest.fn(async () => 0);

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    authUser: {
      findMany: mockFindMany,
      count: mockCount,
    },
  },
}));

import { adminUsersRepository } from "../../src/repositories/admin-users.repository.js";

function baseParams(
  overrides: Partial<
    Parameters<typeof adminUsersRepository.adminListUsers>[0]
  > = {}
) {
  return {
    search: "",
    status: [] as string[],
    createdAfter: "",
    createdBefore: "",
    sortField: "",
    sortDir: "",
    limit: 20,
    offset: 0,
    userIds: [] as string[],
    excludeUserIds: [] as string[],
    ...overrides,
  };
}

const REAL_UUID_1 = "11111111-1111-4111-8111-111111111111";
const REAL_UUID_2 = "22222222-2222-4222-8222-222222222222";
const SEED_ID = "u_seed_29";

describe("adminUsersRepository.adminListUsers — status filter + malformed-id guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not throw and drops non-UUID excludeUserIds (status=ACTIVE excluding mirror-banned dev-seed ids)", async () => {
    await expect(
      adminUsersRepository.adminListUsers(
        baseParams({
          status: ["ACTIVE"],
          excludeUserIds: [SEED_ID, REAL_UUID_1],
        })
      )
    ).resolves.toEqual({ users: [], total: 0 });

    const where = mockFindMany.mock.calls[0][0].where;
    const notInFragment = where.AND.find(
      (f: Record<string, unknown>) =>
        (f as { id?: { notIn?: string[] } }).id?.notIn
    );
    expect(notInFragment.id.notIn).toEqual([REAL_UUID_1]);
    expect(notInFragment.id.notIn).not.toContain(SEED_ID);
  });

  it("drops non-UUID userIds from the constrain-to-these-ids filter", async () => {
    await adminUsersRepository.adminListUsers(
      baseParams({ userIds: [SEED_ID, REAL_UUID_1, REAL_UUID_2] })
    );

    const where = mockFindMany.mock.calls[0][0].where;
    const inFragment = where.AND.find(
      (f: Record<string, unknown>) => (f as { id?: { in?: string[] } }).id?.in
    );
    expect(inFragment.id.in).toEqual([REAL_UUID_1, REAL_UUID_2]);
  });

  it("omits the id filter entirely when every candidate id is malformed", async () => {
    await adminUsersRepository.adminListUsers(
      baseParams({ userIds: [SEED_ID, "not-a-uuid"] })
    );

    const where = mockFindMany.mock.calls[0][0].where;
    const hasIdIn = (where.AND ?? []).some(
      (f: Record<string, unknown>) => (f as { id?: { in?: string[] } }).id?.in
    );
    expect(hasIdIn).toBe(false);
  });

  it("status=ACTIVE filters to ACTIVE + non-deleted", async () => {
    await adminUsersRepository.adminListUsers(
      baseParams({ status: ["ACTIVE"] })
    );

    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      { OR: [{ status: "ACTIVE", deletedAt: null }] },
    ]);
  });

  it("status=BANNED filters to BANNED", async () => {
    await adminUsersRepository.adminListUsers(
      baseParams({ status: ["BANNED"] })
    );

    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([{ OR: [{ status: "BANNED" }] }]);
  });

  it("no status filter (ALL) omits the status fragment", async () => {
    await adminUsersRepository.adminListUsers(baseParams());

    const where = mockFindMany.mock.calls[0][0].where;
    expect(where).toEqual({});
  });

  it("search + status combine as separate AND fragments", async () => {
    await adminUsersRepository.adminListUsers(
      baseParams({ search: "alex", status: ["BANNED"] })
    );

    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      {
        OR: [
          { email: { contains: "alex", mode: "insensitive" } },
          { account: { contains: "alex", mode: "insensitive" } },
        ],
      },
      { OR: [{ status: "BANNED" }] },
    ]);
  });

  it("pagination + status: skip/take derive from offset/limit, where unaffected", async () => {
    await adminUsersRepository.adminListUsers(
      baseParams({ status: ["ACTIVE"], limit: 10, offset: 30 })
    );

    const call = mockFindMany.mock.calls[0][0];
    expect(call.skip).toBe(30);
    expect(call.take).toBe(10);
    expect(call.where.AND).toEqual([
      { OR: [{ status: "ACTIVE", deletedAt: null }] },
    ]);
  });

  it("still runs findMany + count in parallel and returns { users, total }", async () => {
    mockFindMany.mockResolvedValueOnce([{ id: REAL_UUID_1 }] as never);
    mockCount.mockResolvedValueOnce(1);

    const result = await adminUsersRepository.adminListUsers(baseParams());

    expect(result).toEqual({ users: [{ id: REAL_UUID_1 }], total: 1 });
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockCount).toHaveBeenCalledTimes(1);
  });
});
