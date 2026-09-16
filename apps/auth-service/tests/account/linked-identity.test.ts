/**
 * One additional identity per account: an OTP-verified email OR a Google/Apple
 * link, never both. Runs the REAL repositories and services over an in-memory
 * Prisma double whose `SELECT ... FOR UPDATE` blocks like a Postgres row lock,
 * so the concurrency spec proves the lock is taken before the state is read.
 */
type UserRow = {
  id: string;
  account: string;
  email: string | null;
  emailVerified: boolean;
  passwordHash: string | null;
  primaryAccount: string | null;
  status: string;
  deletedAt: Date | null;
  lockedUntil: Date | null;
  role: string;
};
type LinkRow = {
  id: string;
  userId: string;
  provider: string;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  linkedAt: Date;
};

const db: { users: UserRow[]; links: LinkRow[] } = { users: [], links: [] };
const rowLocks = new Map<string, Promise<void>>();
const tick = () => new Promise((resolve) => setImmediate(resolve));

function uniqueError() {
  const { Prisma } = jest.requireActual("../../src/generated/prisma/client.js");
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: ["userId", "provider"] },
  });
}

function withCount(user: UserRow | undefined) {
  if (!user) return null;
  return {
    ...user,
    _count: {
      linkedAccounts: db.links.filter((l) => l.userId === user.id).length,
    },
  };
}

function makeClient(release?: Array<() => void>) {
  return {
    $queryRaw: async (_sql: TemplateStringsArray, userId: string) => {
      while (rowLocks.has(userId)) await rowLocks.get(userId);
      let unlock!: () => void;
      rowLocks.set(
        userId,
        new Promise<void>((resolve) => {
          unlock = () => {
            rowLocks.delete(userId);
            resolve();
          };
        })
      );
      release?.push(unlock);
      return [{ id: userId }];
    },
    authUser: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        await tick();
        return withCount(db.users.find((u) => u.id === where.id));
      },
      findFirst: async ({
        where,
      }: {
        where: { email: string; id: { not: string } };
      }) => {
        await tick();
        return (
          db.users.find(
            (u) => u.email === where.email && u.id !== where.id.not
          ) ?? null
        );
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<UserRow>;
      }) => {
        await tick();
        const user = db.users.find((u) => u.id === where.id)!;
        Object.assign(user, data);
        return user;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; primaryAccount: null };
        data: Partial<UserRow>;
      }) => {
        await tick();
        const user = db.users.find(
          (u) => u.id === where.id && u.primaryAccount === null
        );
        if (user) Object.assign(user, data);
        return { count: user ? 1 : 0 };
      },
    },
    linkedAccount: {
      findUnique: async ({
        where,
      }: {
        where: {
          provider_providerUserId?: { provider: string; providerUserId: string };
          userId_provider?: { userId: string; provider: string };
        };
      }) => {
        await tick();
        const byProvider = where.provider_providerUserId;
        const byUser = where.userId_provider;
        const link = db.links.find((l) =>
          byProvider
            ? l.provider === byProvider.provider &&
              l.providerUserId === byProvider.providerUserId
            : l.userId === byUser!.userId && l.provider === byUser!.provider
        );
        if (!link) return null;
        return {
          ...link,
          user: db.users.find((u) => u.id === link.userId),
        };
      },
      create: async ({ data }: { data: Omit<LinkRow, "id" | "linkedAt"> }) => {
        await tick();
        if (
          db.links.some(
            (l) =>
              (l.provider === data.provider &&
                l.providerUserId === data.providerUserId) ||
              (l.userId === data.userId && l.provider === data.provider)
          )
        ) {
          throw uniqueError();
        }
        const row = {
          id: `link-${db.links.length + 1}`,
          email: null,
          emailVerified: false,
          displayName: null,
          ...data,
          linkedAt: new Date(),
        };
        db.links.push(row);
        return row;
      },
    },
  };
}

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ...makeClient(),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const release: Array<() => void> = [];
      try {
        return await fn(makeClient(release));
      } finally {
        release.forEach((unlock) => unlock());
      }
    },
  },
}));
jest.mock("../../src/lib/otp.js", () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
  generateOtpCode: jest.fn(() => "123456"),
  hashOtpCode: jest.fn(async () => "hashed-code"),
  logDevOtp: jest.fn(),
  verifyAndConsumeOtp: jest.fn(async () => undefined),
}));
jest.mock("../../src/lib/profile-socket.js", () => ({
  emitProfileUpdatedSafe: jest.fn(),
}));

import request from "supertest";

import app from "../../src/app.js";
import { verifyAppleIdToken } from "../../src/lib/apple-id-token.js";
import { verifyGoogleIdToken } from "../../src/lib/google-id-token.js";
import { verifyAndConsumeOtp } from "../../src/lib/otp.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const verifyGoogle = verifyGoogleIdToken as unknown as jest.Mock;
const verifyApple = verifyAppleIdToken as unknown as jest.Mock;
const consumeOtp = verifyAndConsumeOtp as unknown as jest.Mock;

function seedUser(overrides: Partial<UserRow> = {}) {
  db.users.push({
    id: TEST_USER_ID,
    account: "johndoe",
    email: null,
    emailVerified: false,
    passwordHash: "hash",
    primaryAccount: null,
    status: "ACTIVE",
    deletedAt: null,
    lockedUntil: null,
    role: "USER",
    ...overrides,
  });
}

function seedLink(provider: "GOOGLE" | "APPLE", userId = TEST_USER_ID) {
  db.links.push({
    id: `seed-${provider}-${userId}`,
    userId,
    provider,
    providerUserId: `${provider.toLowerCase()}-sub-${userId}`,
    email: "john@example.com",
    emailVerified: true,
    displayName: null,
    linkedAt: new Date(),
  });
}

const linkEmail = () =>
  request(app)
    .post("/api/auth/link-email/verify")
    .set(bearer(makeAccessToken()))
    .send({ email: "john@example.com", code: "123456" });

const linkGoogle = () =>
  request(app)
    .post("/api/auth/social/google/link")
    .set(bearer(makeAccessToken()))
    .send({ idToken: "google-token" });

const linkApple = () =>
  request(app)
    .post("/api/auth/social/apple/link")
    .set(bearer(makeAccessToken()))
    .send({ identityToken: "apple-token" });

const identityCount = () =>
  db.links.filter((l) => l.userId === TEST_USER_ID).length +
  (db.users.find((u) => u.id === TEST_USER_ID)?.emailVerified ? 1 : 0);

beforeEach(() => {
  db.users = [];
  db.links = [];
  rowLocks.clear();
  consumeOtp.mockReset();
  consumeOtp.mockResolvedValue(undefined);
  verifyGoogle.mockReset();
  verifyGoogle.mockResolvedValue({
    sub: "google-sub-new",
    email: "john@gmail.com",
    emailVerified: true,
    displayName: "John",
  });
  verifyApple.mockReset();
  verifyApple.mockResolvedValue({
    sub: "apple-sub-new",
    email: "john@icloud.com",
    emailVerified: true,
    displayName: null,
  });
});

describe("account name + password, nothing linked yet", () => {
  beforeEach(() => seedUser());

  it("can link an email", async () => {
    const res = await linkEmail();
    expect(res.status).toBe(200);
    expect(db.users[0]).toMatchObject({
      emailVerified: true,
      primaryAccount: "EMAIL",
    });
  });

  it("can link Google", async () => {
    const res = await linkGoogle();
    expect(res.status).toBe(200);
    expect(res.body.data.primaryAccount).toBe("GOOGLE");
  });

  it("can link Apple", async () => {
    const res = await linkApple();
    expect(res.status).toBe(200);
    expect(res.body.data.primaryAccount).toBe("APPLE");
  });
});

describe("account name + password + linked email", () => {
  beforeEach(() =>
    seedUser({
      email: "john@example.com",
      emailVerified: true,
      primaryAccount: "EMAIL",
    })
  );

  it.each([
    ["Google", linkGoogle],
    ["Apple", linkApple],
  ])("cannot link %s", async (_label, link) => {
    const res = await link();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AUTH_LINKED_IDENTITY_LIMIT");
    expect(db.links).toHaveLength(0);
  });

  it("cannot link another email", async () => {
    const res = await request(app)
      .post("/api/auth/link-email/request")
      .set(bearer(makeAccessToken()))
      .send({ email: "second@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AUTH_LINKED_IDENTITY_LIMIT");
  });
});

describe.each(["GOOGLE", "APPLE"] as const)(
  "account with a %s identity",
  (provider) => {
    it.each([
      ["linked to an account-name + password account", "hash"],
      ["that founded the account directly", null],
    ])("%s cannot link an email", async (_label, passwordHash) => {
      seedUser({ passwordHash, primaryAccount: provider });
      seedLink(provider);

      const res = await linkEmail();

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("AUTH_LINKED_IDENTITY_LIMIT");
      expect(consumeOtp).not.toHaveBeenCalled();
      expect(db.users[0].emailVerified).toBe(false);
    });

    it("cannot add the other social provider", async () => {
      seedUser({ passwordHash: null, primaryAccount: provider });
      seedLink(provider);

      const res = provider === "GOOGLE" ? await linkApple() : await linkGoogle();

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("AUTH_LINKED_IDENTITY_LIMIT");
      expect(db.links).toHaveLength(1);
    });
  }
);

it("rejects linking the same provider twice with its own code", async () => {
  seedUser({ primaryAccount: "GOOGLE" });
  seedLink("GOOGLE");

  const res = await linkGoogle();

  expect(res.status).toBe(400);
  expect(res.body.code).toBe("AUTH_PROVIDER_ALREADY_LINKED");
});

it("refuses a Google identity that belongs to another account", async () => {
  seedUser();
  seedUser({ id: "other-user", account: "other" });
  seedLink("GOOGLE", "other-user");
  verifyGoogle.mockResolvedValue({
    sub: "google-sub-other-user",
    email: "john@example.com",
    emailVerified: true,
    displayName: null,
  });

  const res = await linkGoogle();

  expect(res.status).toBe(409);
  expect(res.body.code).toBe("AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE");
  expect(db.links.map((l) => l.userId)).toEqual(["other-user"]);
});

it("refuses an email that belongs to another account", async () => {
  seedUser();
  seedUser({
    id: "other-user",
    account: "other",
    email: "john@example.com",
    emailVerified: true,
  });

  const res = await linkEmail();

  expect(res.status).toBe(409);
  expect(res.body.code).toBe("AUTH_EMAIL_EXISTS");
  expect(db.users[0].emailVerified).toBe(false);
});

it("does not link when the OTP is invalid", async () => {
  const { BadRequestError } = await import("@aimess/errors");
  seedUser();
  consumeOtp.mockRejectedValue(new BadRequestError("AUTH_OTP_INVALID"));

  const res = await linkEmail();

  expect(res.status).toBe(400);
  expect(identityCount()).toBe(0);
});

it("does not link when the provider token fails verification", async () => {
  seedUser();
  verifyGoogle.mockRejectedValue(new Error("bad token"));

  const res = await linkGoogle();

  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(db.links).toHaveLength(0);
});

it("lets exactly one of a simultaneous email link and Google link succeed", async () => {
  seedUser();

  const [email, google] = await Promise.all([linkEmail(), linkGoogle()]);

  expect([email.status, google.status].sort()).toEqual([200, 409]);
  expect(identityCount()).toBe(1);
});

it("leaves a legacy account holding both identities untouched and links nothing more", async () => {
  seedUser({
    email: "john@example.com",
    emailVerified: true,
    primaryAccount: null,
  });
  seedLink("GOOGLE");

  const res = await linkApple();

  expect(res.status).toBe(409);
  expect(db.users[0]).toMatchObject({
    email: "john@example.com",
    emailVerified: true,
  });
  expect(db.links.map((l) => l.provider)).toEqual(["GOOGLE"]);
});
