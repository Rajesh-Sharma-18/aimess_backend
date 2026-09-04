/**
 * AIM-23 — the bootstrap super-admin was seeded on `yopmail.com`, a public
 * disposable-mail service whose inbox anyone can read without signing in.
 * Password reset sends a code there, so the account handed over every RBAC
 * permission on the platform to anyone who knew the address, with nothing to
 * guess.
 *
 * The seed and the reset path refuse those domains now. That protects a NEW
 * environment and does nothing for the ones that already ran the old seed,
 * where the account is live right now — which is why this runs at boot instead
 * of living in a runbook nobody reads.
 */

type Admin = { id: string; email: string; status: string };

let admins: Admin[] = [];

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    adminUser: {
      async findMany({ where }: { where: { status: { in: string[] } } }) {
        return admins
          .filter((a) => where.status.in.includes(a.status))
          .map(({ id, email }) => ({ id, email }));
      },
      async updateMany({
        where,
        data,
      }: {
        where: { id: { in: string[] } };
        data: { status: string };
      }) {
        let count = 0;
        for (const admin of admins) {
          if (where.id.in.includes(admin.id)) {
            admin.status = data.status;
            count += 1;
          }
        }
        return { count };
      },
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reconcileDisposableAdmins } =
  require("../../src/lib/disposable-admin-reconciler.js") as typeof import("../../src/lib/disposable-admin-reconciler.js");

describe("disposable-mail admin reconciliation", () => {
  it("disables the account the old seed left behind", async () => {
    admins = [
      { id: "1", email: "superadmin@yopmail.com", status: "ACTIVE" },
      { id: "2", email: "ops@aimess.example", status: "ACTIVE" },
    ];

    await expect(reconcileDisposableAdmins()).resolves.toBe(1);

    expect(admins.find((a) => a.id === "1")?.status).toBe("DISABLED");
    expect(admins.find((a) => a.id === "2")?.status).toBe("ACTIVE");
  });

  it("covers an account that was invited but never signed in", async () => {
    // An INVITED account still has a working password-reset path, so a readable
    // inbox is just as good as a password.
    admins = [{ id: "1", email: "pending@mailinator.com", status: "INVITED" }];

    await expect(reconcileDisposableAdmins()).resolves.toBe(1);
    expect(admins[0]?.status).toBe("DISABLED");
  });

  it("does not resurrect and re-disable an already-deleted row", async () => {
    // Soft-deleted rows are kept for the audit trail. Rewriting their status
    // would lose the distinction between "no longer exists" and "deactivated".
    admins = [{ id: "1", email: "old@yopmail.com", status: "DELETED" }];

    await expect(reconcileDisposableAdmins()).resolves.toBe(0);
    expect(admins[0]?.status).toBe("DELETED");
  });

  it("leaves a clean environment completely alone", async () => {
    admins = [
      { id: "1", email: "ops@aimess.example", status: "ACTIVE" },
      { id: "2", email: "security@aimess.example", status: "ACTIVE" },
    ];

    await expect(reconcileDisposableAdmins()).resolves.toBe(0);
    expect(admins.every((a) => a.status === "ACTIVE")).toBe(true);
  });

  it("is idempotent across restarts", async () => {
    admins = [{ id: "1", email: "superadmin@yopmail.com", status: "ACTIVE" }];

    await reconcileDisposableAdmins();
    // The second boot finds nothing to do, rather than reporting the same
    // account again on every restart.
    await expect(reconcileDisposableAdmins()).resolves.toBe(0);
  });
});
