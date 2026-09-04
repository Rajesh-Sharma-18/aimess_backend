/**
 * AIM-44 — a deleted account's personal data must actually be erased here.
 *
 * `user.deleted` only flipped `deletedAt` and `status`. Username, first and
 * last name, bio, avatar, date of birth and the search shadows were all left
 * intact, and the "Deleted Account" the platform showed was a read-time
 * projection over that live data — so the real name and photo stayed in this
 * database indefinitely, and any read path that forgot the projection showed
 * them. A GDPR exposure before it is a security one.
 */

type Profile = Record<string, unknown> & { userId: string };

let profiles: Profile[] = [];

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    userProfile: {
      async updateMany({
        where,
        data,
      }: {
        where: { userId: string };
        data: Record<string, unknown>;
      }) {
        let count = 0;
        for (const profile of profiles) {
          if (profile.userId === where.userId) {
            Object.assign(profile, data);
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

/** Everything on the row that identifies a person. */
function realProfile(): Profile {
  return {
    userId: USER,
    username: "jane_doe",
    firstName: "Jane",
    lastName: "Doe",
    normalizedUsername: "jane_doe",
    normalizedFirstName: "jane",
    normalizedLastName: "doe",
    normalizedFullName: "janedoe",
    account: "jane_doe",
    bio: "Photographer in Hanoi",
    gender: "FEMALE",
    avatarUrl: "avatars/jane.jpg",
    coverImageUrl: "avatars/jane-cover.jpg",
    dateOfBirth: new Date("1994-03-11T00:00:00.000Z"),
  };
}

beforeEach(() => {
  profiles = [realProfile()];
});

describe("user.purged — user-service profile erasure", () => {
  it("leaves nothing on the row that identifies the person", async () => {
    await handleUserPurged({ userId: USER } as never);

    const row = profiles[0] as Profile;
    for (const value of Object.values(row)) {
      if (typeof value === "string") {
        expect(value.toLowerCase()).not.toContain("jane");
        expect(value.toLowerCase()).not.toContain("doe");
        expect(value.toLowerCase()).not.toContain("hanoi");
      }
    }
    expect(row.avatarUrl).toBeNull();
    expect(row.coverImageUrl).toBeNull();
    expect(row.bio).toBeNull();
    expect(row.gender).toBeNull();
    expect(row.account).toBeNull();
  });

  it("erases the search shadows too", async () => {
    // The normalized columns are lowercase copies of the name columns. Leaving
    // them would keep the real name SEARCHABLE after the name itself was
    // erased — the exact leak the erasure exists to close.
    await handleUserPurged({ userId: USER } as never);

    const row = profiles[0] as Profile;
    expect(row.normalizedFirstName).toBe("deleted");
    expect(row.normalizedLastName).toBe("account");
    expect(row.normalizedFullName).toBe("deletedaccount");
    expect(row.normalizedUsername).toBe(row.username);
  });

  it("replaces the birth date rather than blanking it", async () => {
    // Not nullable in the schema. The epoch is an unmistakable "erased" marker;
    // a plausible date could be mistaken for a real one.
    await handleUserPurged({ userId: USER } as never);

    expect((profiles[0]?.dateOfBirth as Date).getTime()).toBe(0);
  });

  it("gives each user a distinct placeholder handle", async () => {
    // `username` is uniquely indexed, so a shared placeholder would make the
    // SECOND purge fail — and leave that user's real handle in place.
    profiles = [realProfile(), { ...realProfile(), userId: "user-2" }];

    await handleUserPurged({ userId: USER } as never);
    await handleUserPurged({ userId: "user-2" } as never);

    expect(profiles[0]?.username).not.toBe(profiles[1]?.username);
  });

  it("is idempotent, so a dead-letter replay is safe", async () => {
    await handleUserPurged({ userId: USER } as never);
    const first = { ...(profiles[0] as Profile) };

    await handleUserPurged({ userId: USER } as never);

    expect(profiles[0]).toEqual(first);
  });

  it("does not fail for an account that never completed a profile", async () => {
    profiles = [];

    await expect(handleUserPurged({ userId: USER } as never)).resolves.toBeUndefined();
  });

  it("touches only the purged user", async () => {
    const other = { ...realProfile(), userId: "user-2" };
    profiles = [realProfile(), other];

    await handleUserPurged({ userId: USER } as never);

    expect(profiles[1]?.firstName).toBe("Jane");
  });
});
