/**
 * `GET /communities/mine` — MEMBERSHIP-SCOPE proof.
 *
 * The reported bug: a brand-new user with zero memberships opened the Community
 * screen and `/api/v1/communities/mine?limit=50` came back full of communities.
 * Root cause was the controller's mode inference — with no cursor param the V1
 * handler fell through to `discover()` (public browse). That half is pinned in
 * `tests/communities/discovery.test.ts`; this file pins the other half — that
 * the joined-mode repository query only ever matches the caller's OWN eligible
 * membership rows, so a user with none gets an empty page.
 *
 * Both `listMineByActivity` (V1) and `listMineByActivityKeyset` (V2) run for
 * real against a faithful emulator of Prisma's `members: { some: ... }`
 * semantics, over the full membership-state matrix: active, never joined,
 * voluntarily left, admin-kicked, banned, banned-then-dismissed, unbanned,
 * invited-only (PENDING), rejoined, and another user's membership.
 *
 * Banned / unbanned-but-not-dismissed rows stay visible BY DESIGN (zero access —
 * every read/write returns USER_BANNED — until the user dismisses the entry
 * themselves); that is the existing product rule, asserted here so a future
 * change to it is deliberate rather than accidental.
 */

jest.unmock("../../src/repositories/community.repository.js");

type Member = {
  userId: string;
  status: "ACTIVE" | "LEFT" | "BANNED" | "PENDING";
  dismissedAt?: Date;
  bannedAt?: Date;
  unbannedAt?: Date;
};
type Row = { id: string; lastActivityAt: Date; members: Member[] };

let store: Row[] = [];
const findManyMock = jest.fn();
const countMock = jest.fn();

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: {
      findMany: (args: unknown) => findManyMock(args),
      count: (args: unknown) => countMock(args),
    },
  },
}));

// Echo proxy: `CommunityMemberStatus.ACTIVE` → "ACTIVE", matching the status
// strings the emulator below compares against.
jest.mock("../../src/generated/prisma/index.js", () => {
  const echo = () =>
    new Proxy(
      {},
      { get: (_t, key) => (typeof key === "string" ? key : undefined) }
    );
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "__esModule") return true;
        return echo();
      },
    }
  );
});

import { communityRepository } from "../../src/repositories/community.repository.js";

const USER = "111111111111111111111111";
const OTHER = "222222222222222222222222";

// --- Emulator of Prisma's `members: { some: <filter> }` ----------------------
type IsSet = { isSet: boolean };
type MemberFilter = {
  userId: string;
  OR: Array<{ status: string; dismissedAt?: IsSet; unbannedAt?: IsSet }>;
};

/** `{ isSet: false }` → field absent; `{ isSet: true }` → field present. */
function matchesIsSet(value: Date | undefined, cond?: IsSet): boolean {
  if (!cond) return true;
  return cond.isSet ? value !== undefined : value === undefined;
}

function memberMatches(member: Member, filter: MemberFilter): boolean {
  if (member.userId !== filter.userId) return false;
  return filter.OR.some(
    (clause) =>
      member.status === clause.status &&
      matchesIsSet(member.dismissedAt, clause.dismissedAt) &&
      matchesIsSet(member.unbannedAt, clause.unbannedAt)
  );
}

/** V1 bounds `lastActivityAt`; V2 bounds a compound `$or` keyset (or nothing). */
type Where = {
  members: { some: MemberFilter };
  lastActivityAt?: { lte?: Date; gte?: Date };
  OR?: Array<
    | { lastActivityAt: { lt: Date } }
    | { lastActivityAt: Date; id: { lt: string } }
  >;
};

function passesMembership(row: Row, where: Where): boolean {
  return row.members.some((m) => memberMatches(m, where.members.some));
}

function passesBoundary(row: Row, where: Where): boolean {
  if (where.lastActivityAt) {
    const { lte, gte } = where.lastActivityAt;
    if (lte && row.lastActivityAt.getTime() > lte.getTime()) return false;
    if (gte && row.lastActivityAt.getTime() < gte.getTime()) return false;
  }
  if (where.OR) {
    return where.OR.some((clause) =>
      "id" in clause
        ? row.lastActivityAt.getTime() === clause.lastActivityAt.getTime() &&
          row.id < clause.id.lt
        : row.lastActivityAt.getTime() < clause.lastActivityAt.lt.getTime()
    );
  }
  return true;
}

beforeEach(() => {
  findManyMock.mockReset();
  countMock.mockReset();
  findManyMock.mockImplementation(
    async (args: { where: Where; take: number }) =>
      store
        .filter(
          (r) =>
            passesMembership(r, args.where) && passesBoundary(r, args.where)
        )
        .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
        .slice(0, args.take)
        .map((r) => ({ ...r }))
  );
  countMock.mockImplementation(
    async (args: { where: Where }) =>
      store.filter((r) => passesMembership(r, args.where)).length
  );
});

const base = 1_784_000_000_000;
let seq = 0;
function community(members: Member[]): Row {
  return {
    id: String(++seq).padStart(24, "0"),
    lastActivityAt: new Date(base - seq * 1000),
    members,
  };
}

async function mineV1(userId = USER): Promise<string[]> {
  const { rows } = await communityRepository.listMineByActivity({
    userId,
    direction: "before",
    ts: new Date(base + 60_000),
    limit: 50,
  });
  return (rows as unknown as Row[]).map((r) => r.id);
}

async function mineV2(userId = USER): Promise<string[]> {
  const { rows } = await communityRepository.listMineByActivityKeyset({
    userId,
    cursor: null,
    limit: 50,
  });
  return (rows as unknown as Row[]).map((r) => r.id);
}

describe("communities/mine — only the caller's own eligible memberships", () => {
  it("returns an empty page for a brand-new user with zero memberships", async () => {
    seq = 0;
    // A populated platform: 30 communities, none of them the new user's.
    store = Array.from({ length: 30 }, () =>
      community([{ userId: OTHER, status: "ACTIVE" }])
    );

    expect(await mineV1()).toEqual([]);
    expect(await mineV2()).toEqual([]);
  });

  it("covers the full membership-state matrix identically in V1 and V2", async () => {
    seq = 0;
    const active = community([{ userId: USER, status: "ACTIVE" }]);
    const neverJoined = community([]);
    const otherUserOnly = community([{ userId: OTHER, status: "ACTIVE" }]);
    const left = community([{ userId: USER, status: "LEFT" }]);
    // Admin kick: LEFT with no unbannedAt → back to a plain non-member.
    const kicked = community([{ userId: USER, status: "LEFT" }]);
    const invitedOnly = community([{ userId: USER, status: "PENDING" }]);
    // Banned (not dismissed) and unbanned (not dismissed) stay visible by design.
    const banned = community([
      { userId: USER, status: "BANNED", bannedAt: new Date(base) },
    ]);
    const bannedDismissed = community([
      {
        userId: USER,
        status: "BANNED",
        bannedAt: new Date(base),
        dismissedAt: new Date(base),
      },
    ]);
    const unbanned = community([
      { userId: USER, status: "LEFT", unbannedAt: new Date(base) },
    ]);
    const unbannedDismissed = community([
      {
        userId: USER,
        status: "LEFT",
        unbannedAt: new Date(base),
        dismissedAt: new Date(base),
      },
    ]);

    store = [
      active,
      neverJoined,
      otherUserOnly,
      left,
      kicked,
      invitedOnly,
      banned,
      bannedDismissed,
      unbanned,
      unbannedDismissed,
    ];

    const expected = [active.id, banned.id, unbanned.id].sort();
    expect((await mineV1()).sort()).toEqual(expected);
    expect((await mineV2()).sort()).toEqual(expected);

    const v1 = await mineV1();
    const v2 = await mineV2();
    for (const id of [
      neverJoined.id,
      otherUserOnly.id,
      left.id,
      kicked.id,
      invitedOnly.id,
      bannedDismissed.id,
      unbannedDismissed.id,
    ]) {
      expect(v1).not.toContain(id);
      expect(v2).not.toContain(id);
    }
  });

  it("two users never see each other's communities", async () => {
    seq = 0;
    const a1 = community([{ userId: USER, status: "ACTIVE" }]);
    const a2 = community([{ userId: USER, status: "ACTIVE" }]);
    const b1 = community([{ userId: OTHER, status: "ACTIVE" }]);
    store = [a1, a2, b1];

    expect((await mineV1(USER)).sort()).toEqual([a1.id, a2.id].sort());
    expect(await mineV1(OTHER)).toEqual([b1.id]);
  });

  it("join → leave → rejoin: the community comes back, not blacklisted", async () => {
    seq = 0;
    const c = community([{ userId: USER, status: "ACTIVE" }]);
    store = [c];
    expect(await mineV1()).toEqual([c.id]);

    // Leave: the membership row flips to LEFT (history stays in the DB).
    c.members = [{ userId: USER, status: "LEFT" }];
    expect(await mineV1()).toEqual([]);

    // Rejoin reactivates the same row.
    c.members = [{ userId: USER, status: "ACTIVE" }];
    expect(await mineV1()).toEqual([c.id]);
  });

  it("`total` is scoped to the caller too — pagination can't over-report", async () => {
    seq = 0;
    store = [
      community([{ userId: USER, status: "ACTIVE" }]),
      community([{ userId: USER, status: "ACTIVE" }]),
      ...Array.from({ length: 20 }, () =>
        community([{ userId: OTHER, status: "ACTIVE" }])
      ),
    ];

    const v1 = await communityRepository.listMineByActivity({
      userId: USER,
      direction: "before",
      ts: new Date(base + 60_000),
      limit: 50,
    });
    expect(v1.total).toBe(2);

    const v2 = await communityRepository.listMineByActivityKeyset({
      userId: USER,
      cursor: null,
      limit: 50,
    });
    expect(v2.total).toBe(2);
  });

  it("filters BEFORE pagination — a short page never hides eligible communities", async () => {
    seq = 0;
    // 60 non-member communities are the NEWEST rows; a filter-after-fetch
    // implementation would return an empty first page here.
    store = [
      ...Array.from({ length: 60 }, () =>
        community([{ userId: OTHER, status: "ACTIVE" }])
      ),
      ...Array.from({ length: 5 }, () =>
        community([{ userId: USER, status: "ACTIVE" }])
      ),
    ];

    expect(await mineV1()).toHaveLength(5);
  });
});
