/**
 * AIM-44 — community-service consumed no user lifecycle event at all, so a
 * deleted account's name and avatar stayed on every `CommunityMember` row.
 * Those are denormalised snapshots taken at join time and rendered directly in
 * member lists, so the person's real name kept appearing across the platform
 * after they deleted their account.
 */

type Member = Record<string, unknown> & { userId: string };

let members: Member[] = [];

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    communityMember: {
      async updateMany({
        where,
        data,
      }: {
        where: { userId: string };
        data: Record<string, unknown>;
      }) {
        let count = 0;
        for (const member of members) {
          if (member.userId === where.userId) {
            Object.assign(member, data);
            count += 1;
          }
        }
        return { count };
      },
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handleUserPurged } =
  require("../../src/handlers/user-purged.handler.js") as typeof import("../../src/handlers/user-purged.handler.js");

const USER = "user-1";

function membership(overrides: Partial<Member> = {}): Member {
  return {
    userId: USER,
    communityId: "comm-1",
    role: "MEMBER",
    joinedAt: new Date("2026-01-01T00:00:00.000Z"),
    snapshotUsername: "jane_doe",
    snapshotDisplayName: "Jane Doe",
    snapshotAvatarKey: "avatars/jane.jpg",
    ...overrides,
  };
}

beforeEach(() => {
  members = [membership()];
});

describe("user.purged — community member snapshots", () => {
  it("erases the identity snapshot on every membership", async () => {
    members = [
      membership(),
      membership({ communityId: "comm-2" }),
      membership({ communityId: "comm-3" }),
    ];

    await handleUserPurged({ userId: USER } as never);

    for (const member of members) {
      expect(member.snapshotUsername).toBe("deleted");
      expect(member.snapshotDisplayName).toBe("Deleted Account");
    }
  });

  it("nulls the avatar key rather than blanking it", async () => {
    // The key addresses an object in the avatar bucket. A null tells every read
    // path to fall back to the default avatar; an empty string would be signed
    // into a broken URL, and a surviving key would still resolve to a photo of
    // someone who deleted it.
    await handleUserPurged({ userId: USER } as never);

    expect(members[0]?.snapshotAvatarKey).toBeNull();
  });

  it("keeps the membership itself", async () => {
    // Role, join time and moderation history belong to the community and are
    // referenced elsewhere by userId. Only the snapshot columns are personal.
    await handleUserPurged({ userId: USER } as never);

    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("MEMBER");
    expect(members[0]?.communityId).toBe("comm-1");
  });

  it("is idempotent, so a dead-letter replay is safe", async () => {
    await handleUserPurged({ userId: USER } as never);
    const first = { ...(members[0] as Member) };

    await handleUserPurged({ userId: USER } as never);

    expect(members[0]).toEqual(first);
  });

  it("does not fail for a user who joined no community", async () => {
    members = [];

    await expect(handleUserPurged({ userId: USER } as never)).resolves.toBeUndefined();
  });

  it("leaves other members untouched", async () => {
    members = [membership(), membership({ userId: "user-2" })];

    await handleUserPurged({ userId: USER } as never);

    expect(members[1]?.snapshotDisplayName).toBe("Jane Doe");
  });
});
