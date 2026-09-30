/**
 * Super Admin community member count + roster.
 *
 * The reported bug: "Mission AIMESS" showed 13 members on the website and 16 in
 * Super Admin. The website reads the stored `memberCount` (ACTIVE rows); the
 * admin detail counted EVERY CommunityMember row, so the three LEFT rows (a
 * voluntary leave, an admin kick, an unban) inflated it to 16.
 *
 * Pinned here against an in-memory emulator of the Prisma calls:
 *   - ACTIVE community: headline count = ACTIVE rows (ADMIN + MODERATOR +
 *     MEMBER); LEFT / BANNED / PENDING never count; the member list hides LEFT
 *     so its pagination total matches what it shows.
 *   - CLOSED community: count and roster are frozen at the first close; a
 *     later leave changes neither; reopen restores the live rule.
 */

jest.unmock("../../src/repositories/community.repository.js");

type Member = {
  id: string;
  communityId: string;
  userId: string;
  role: "ADMIN" | "MODERATOR" | "MEMBER";
  status: "ACTIVE" | "LEFT" | "BANNED" | "PENDING";
  joinedAt: Date;
  closureRosterAt: Date | null;
  snapshotUsername: string;
  snapshotDisplayName: string;
  snapshotAvatarKey: string | null;
};
type Community = {
  id: string;
  adminId: string;
  memberCount: number;
  memberCountAtClosure: number | null;
  status: "ACTIVE" | "CLOSED";
  moderationStatus: "ACTIVE" | "SUSPENDED";
};

let members: Member[] = [];
let community: Community;

// Minimal Prisma `where` matcher for the operators these queries use.
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") {
      return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("not" in c) return c.not === null ? value != null : value !== c.not;
      if ("gte" in c) return (value as Date) >= (c.gte as Date);
      if ("isSet" in c) return (value !== undefined) === c.isSet;
      if ("contains" in c) return true;
      throw new Error(`unsupported filter on ${key}: ${JSON.stringify(c)}`);
    }
    return value === cond;
  });
}

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: {
      findFirst: async () => ({ ...community, category: null }),
      findUnique: async () => ({ ...community }),
      update: async ({ data }: { data: Partial<Community> }) =>
        Object.assign(community, data),
    },
    communityMember: {
      count: async ({ where }: { where: Record<string, unknown> }) =>
        members.filter((m) => matches(m, where)).length,
      findMany: async ({
        where,
        skip = 0,
        take,
      }: {
        where: Record<string, unknown>;
        skip?: number;
        take?: number;
      }) =>
        members
          .filter((m) => matches(m, where))
          .slice(skip, take === undefined ? undefined : skip + take),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        members.find((m) => matches(m, where)) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<Member>;
      }) => {
        const hit = members.filter((m) => matches(m, where));
        hit.forEach((m) => Object.assign(m, data));
        return { count: hit.length };
      },
    },
    communityReport: { count: async () => 0 },
    communityInviteLink: { count: async () => 0 },
  },
}));

// Echo proxy: `CommunityMemberStatus.ACTIVE` → "ACTIVE".
jest.mock("../../src/generated/prisma/index.js", () => {
  const echo = () =>
    new Proxy({}, { get: (_t, key) => (typeof key === "string" ? key : undefined) });
  return new Proxy(
    {},
    { get: (_t, prop) => (prop === "__esModule" ? true : echo()) }
  );
});

import { communityRepository } from "../../src/repositories/community.repository.js";

const CID = "6a321d35afccb246b6e80b6b";
let seq = 0;
function member(role: Member["role"], status: Member["status"]): Member {
  seq += 1;
  return {
    id: `m${seq}`,
    communityId: CID,
    userId: `u${seq}`,
    role,
    status,
    joinedAt: new Date(2026, 5, seq),
    closureRosterAt: null,
    snapshotUsername: `user${seq}`,
    snapshotDisplayName: `User ${seq}`,
    snapshotAvatarKey: null,
  };
}

async function headline(): Promise<number> {
  const detail = await communityRepository.adminGetCommunityDetail(CID);
  return detail!.membersTotal;
}
async function roster(): Promise<{ ids: string[]; total: number }> {
  const { rows, total } = await communityRepository.adminListCommunityMembers({
    communityId: CID,
    page: 1,
    limit: 50,
  });
  return { ids: rows.map((r) => r.userId), total };
}

beforeEach(() => {
  seq = 0;
  // Mission AIMESS as found on dev: 1 ADMIN + 6 MODERATOR + 6 MEMBER ACTIVE,
  // plus 3 LEFT rows (voluntary leave, unban, admin kick).
  members = [
    member("ADMIN", "ACTIVE"),
    ...Array.from({ length: 6 }, () => member("MODERATOR", "ACTIVE")),
    ...Array.from({ length: 6 }, () => member("MEMBER", "ACTIVE")),
    ...Array.from({ length: 3 }, () => member("MEMBER", "LEFT")),
  ];
  community = {
    id: CID,
    adminId: "u1",
    memberCount: 13,
    memberCountAtClosure: null,
    status: "ACTIVE",
    moderationStatus: "ACTIVE",
  };
});

describe("active community", () => {
  it("counts ACTIVE admin + moderators + members only — 13, not 16 rows", async () => {
    expect(members).toHaveLength(16);
    expect(await headline()).toBe(13);
    expect(await headline()).toBe(community.memberCount);
  });

  it("never counts banned or pending (join-request) rows", async () => {
    members.push(member("MEMBER", "BANNED"), member("MEMBER", "PENDING"));
    expect(await headline()).toBe(13);
  });

  it("member list hides LEFT rows and its total matches the rows shown", async () => {
    members.push(member("MEMBER", "BANNED"));
    const { ids, total } = await roster();
    expect(total).toBe(14); // 13 ACTIVE + 1 BANNED (still shown for Unban)
    expect(ids).toHaveLength(14);
    expect(ids).not.toEqual(expect.arrayContaining(["u14", "u15", "u16"]));
  });
});

describe("closed community", () => {
  it("freezes the count and roster at closure; a later leave changes neither", async () => {
    members.push(member("MEMBER", "BANNED"));
    community.status = "CLOSED";
    await communityRepository.captureClosureSnapshot(CID, new Date());
    expect(community.memberCountAtClosure).toBe(13);

    // Two members leave the closed community afterwards.
    members[12].status = "LEFT";
    members[11].status = "LEFT";
    community.memberCount = 11;

    expect(await headline()).toBe(13);
    const { ids, total } = await roster();
    expect(total).toBe(14);
    expect(ids).toEqual(expect.arrayContaining(["u12", "u13", "u17"]));
    // Rows that had already left before the close are not part of it.
    expect(ids).not.toEqual(expect.arrayContaining(["u14"]));
  });

  it("keeps the first snapshot when the other axis closes too", async () => {
    community.status = "CLOSED";
    await communityRepository.captureClosureSnapshot(CID, new Date());
    members[12].status = "LEFT";
    community.moderationStatus = "SUSPENDED";
    await communityRepository.captureClosureSnapshot(CID, new Date());
    expect(community.memberCountAtClosure).toBe(13);
  });

  it("reopen returns to the live count, but not while still suspended", async () => {
    community.status = "CLOSED";
    community.moderationStatus = "SUSPENDED";
    await communityRepository.captureClosureSnapshot(CID, new Date());
    members[12].status = "LEFT";

    community.status = "ACTIVE"; // owner reopened, platform still suspended
    await communityRepository.clearClosureSnapshot(CID);
    expect(await headline()).toBe(13);

    community.moderationStatus = "ACTIVE";
    await communityRepository.clearClosureSnapshot(CID);
    expect(community.memberCountAtClosure).toBeNull();
    expect(members.every((m) => m.closureRosterAt === null)).toBe(true);
    expect(await headline()).toBe(12);
    expect((await roster()).total).toBe(12);
  });
});
