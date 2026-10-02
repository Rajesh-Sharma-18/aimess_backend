type Row = {
  id: string;
  name: string;
  platform: "ALL" | "ANDROID" | "IOS" | "WEB";
  encryptedValue: string;
  lastFour: string;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
};

const rows = new Map<string, Row>();
let nextId = 0;

jest.mock("../../src/repositories/custom-credential.repository.js", () => ({
  customCredentialRepository: {
    list: jest.fn(async () => [...rows.values()]),
    listForPlatforms: jest.fn(async (platforms: string[]) =>
      [...rows.values()].filter((r) => platforms.includes(r.platform))
    ),
    findById: jest.fn(async (id: string) => rows.get(id) ?? null),
    findByNameAndPlatform: jest.fn(
      async (name: string, platform: string) =>
        [...rows.values()].find(
          (r) => r.name === name && r.platform === platform
        ) ?? null
    ),
    create: jest.fn(async (data: Record<string, string>) => {
      nextId += 1;
      const row: Row = {
        id: `00000000-0000-4000-8000-00000000000${nextId}`,
        name: data.name,
        platform: data.platform as Row["platform"],
        encryptedValue: data.encryptedValue,
        lastFour: data.lastFour,
        createdById: data.actorId,
        updatedById: data.actorId,
        createdAt: new Date(1_000),
        updatedAt: new Date(1_000),
      };
      rows.set(row.id, row);
      return row;
    }),
    update: jest.fn(
      async (id: string, data: Record<string, string | undefined>) => {
        const row = rows.get(id)!;
        const next = {
          ...row,
          ...Object.fromEntries(
            Object.entries(data).filter(
              ([k, v]) => k !== "actorId" && v !== undefined
            )
          ),
          updatedAt: new Date(2_000),
        } as Row;
        rows.set(id, next);
        return next;
      }
    ),
    delete: jest.fn(async (id: string) => {
      rows.delete(id);
    }),
  },
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => undefined) },
}));

import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "@aimess/errors";

import { env } from "../../src/config/env.js";
import { AUDIT_ACTIONS } from "../../src/constants/index.js";
import { customCredentialService } from "../../src/services/custom-credential.service.js";
import { auditService } from "../../src/services/audit.service.js";

const audit = auditService as unknown as { record: jest.Mock };
const mutableEnv = env as { CUSTOM_CREDENTIALS_ENCRYPTION_KEY?: string };
const KEY = mutableEnv.CUSTOM_CREDENTIALS_ENCRYPTION_KEY;
const ACTOR = "11111111-1111-4111-8111-111111111111";
const CTX = { ip: "127.0.0.1", userAgent: "jest" };
const SECRET = "giphy-secret-key-abcd1234";

const createGiphy = (platform: Row["platform"] = "WEB", value = SECRET) =>
  customCredentialService.create(
    { name: "GIPHY_API_KEY", platform, value },
    ACTOR,
    CTX
  );

beforeEach(() => {
  rows.clear();
  nextId = 0;
  jest.clearAllMocks();
  mutableEnv.CUSTOM_CREDENTIALS_ENCRYPTION_KEY = KEY;
});

describe("customCredentialService", () => {
  it("stores only ciphertext and returns a masked view", async () => {
    const view = await createGiphy();

    const stored = [...rows.values()][0];
    expect(stored.encryptedValue).not.toContain(SECRET);
    expect(view).toEqual({
      id: stored.id,
      name: "GIPHY_API_KEY",
      platform: "WEB",
      maskedValue: "••••1234",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(JSON.stringify(await customCredentialService.list())).not.toContain(
      SECRET
    );
  });

  it("allows the same name once per platform", async () => {
    await createGiphy("ANDROID", "android-key-0001");
    await createGiphy("IOS", "ios-key-0002");
    await expect(createGiphy("ANDROID")).rejects.toBeInstanceOf(ConflictError);
  });

  it("resolves the decrypted value for the requested platform only", async () => {
    await createGiphy("ANDROID", "android-key-0001");
    await createGiphy("IOS", "ios-key-0002");

    await expect(
      customCredentialService.resolve("GIPHY_API_KEY", "ANDROID")
    ).resolves.toEqual({
      configured: true,
      value: "android-key-0001",
    });
    await expect(
      customCredentialService.resolve("GIPHY_API_KEY", "IOS")
    ).resolves.toEqual({
      configured: true,
      value: "ios-key-0002",
    });
    await expect(
      customCredentialService.resolve("GIPHY_API_KEY", "WEB")
    ).resolves.toEqual({
      configured: false,
      value: "",
    });
    await expect(
      customCredentialService.resolve("GIPHY_API_KEY", "DESKTOP")
    ).resolves.toEqual({
      configured: false,
      value: "",
    });
  });

  it("falls back to the all-platforms value unless a platform has its own", async () => {
    await createGiphy("ALL", "shared-key-0000");
    await createGiphy("IOS", "ios-key-0002");

    await expect(
      customCredentialService.resolve("GIPHY_API_KEY", "ANDROID")
    ).resolves.toEqual({
      configured: true,
      value: "shared-key-0000",
    });
    await expect(
      customCredentialService.resolve("GIPHY_API_KEY", "WEB")
    ).resolves.toEqual({
      configured: true,
      value: "shared-key-0000",
    });
    await expect(
      customCredentialService.resolve("GIPHY_API_KEY", "IOS")
    ).resolves.toEqual({
      configured: true,
      value: "ios-key-0002",
    });
    await expect(createGiphy("ALL")).rejects.toBeInstanceOf(ConflictError);
  });

  it("lists every credential for a platform, its own rows overriding the shared ones", async () => {
    await createGiphy("IOS", "ios-key-0002");
    await customCredentialService.create(
      { name: "MAPS_KEY", platform: "ALL", value: "shared-maps-key" },
      ACTOR,
      CTX
    );
    await createGiphy("ALL", "shared-key-0000");

    const ios = await customCredentialService.listForPlatform("IOS");
    expect(Object.fromEntries(ios.map((c) => [c.name, c.value]))).toEqual({
      GIPHY_API_KEY: "ios-key-0002",
      MAPS_KEY: "shared-maps-key",
    });
    const web = await customCredentialService.listForPlatform("WEB");
    expect(Object.fromEntries(web.map((c) => [c.name, c.value]))).toEqual({
      GIPHY_API_KEY: "shared-key-0000",
      MAPS_KEY: "shared-maps-key",
    });
    await expect(
      customCredentialService.listForPlatform("ALL")
    ).resolves.toEqual([]);
    await expect(
      customCredentialService.listForPlatform("DESKTOP")
    ).resolves.toEqual([]);
  });

  it("edits name and platform without touching the stored value", async () => {
    const created = await createGiphy();
    const sealed = rows.get(created.id)!.encryptedValue;

    const view = await customCredentialService.update(
      created.id,
      { name: "GIPHY_WEB_KEY", platform: "IOS" },
      ACTOR,
      CTX
    );

    expect(view).toMatchObject({ name: "GIPHY_WEB_KEY", platform: "IOS" });
    expect(rows.get(created.id)!.encryptedValue).toBe(sealed);
  });

  it("replaces the value and re-encrypts it", async () => {
    const created = await createGiphy();
    const view = await customCredentialService.update(
      created.id,
      { value: "replacement-key-9876" },
      ACTOR,
      CTX
    );
    expect(view.maskedValue).toBe("••••9876");
    await expect(
      customCredentialService.resolve("GIPHY_API_KEY", "WEB")
    ).resolves.toEqual({
      configured: true,
      value: "replacement-key-9876",
    });
  });

  it("refuses an edit that collides with another row", async () => {
    await createGiphy("ANDROID");
    const ios = await createGiphy("IOS");
    await expect(
      customCredentialService.update(
        ios.id,
        { platform: "ANDROID" },
        ACTOR,
        CTX
      )
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("404s on editing or deleting an unknown row", async () => {
    await expect(
      customCredentialService.update("missing", { name: "X_KEY" }, ACTOR, CTX)
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      customCredentialService.remove("missing", ACTOR, CTX)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to store a value when no encryption key is configured", async () => {
    mutableEnv.CUSTOM_CREDENTIALS_ENCRYPTION_KEY = undefined;
    await expect(createGiphy()).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(rows.size).toBe(0);
  });

  it("reveals the decrypted value and audits the view", async () => {
    const created = await createGiphy();

    const detail = await customCredentialService.reveal(created.id, ACTOR, CTX);

    expect(detail).toMatchObject({
      id: created.id,
      name: "GIPHY_API_KEY",
      value: SECRET,
    });
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.CUSTOM_CREDENTIAL_VIEWED,
        after: { name: "GIPHY_API_KEY", platform: "WEB" },
      })
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(SECRET);
    await expect(
      customCredentialService.reveal("missing", ACTOR, CTX)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deletes a credential and audits it", async () => {
    const created = await createGiphy();

    await customCredentialService.remove(created.id, ACTOR, CTX);

    expect(rows.size).toBe(0);
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.CUSTOM_CREDENTIAL_DELETED,
        before: { name: "GIPHY_API_KEY", platform: "WEB" },
      })
    );
  });

  it("never writes the secret into the audit trail", async () => {
    const created = await createGiphy();
    await customCredentialService.update(
      created.id,
      { value: "replacement-key-9876" },
      ACTOR,
      CTX
    );
    await customCredentialService.remove(created.id, ACTOR, CTX);

    const trail = JSON.stringify(audit.record.mock.calls);
    expect(trail).not.toContain(SECRET);
    expect(trail).not.toContain("replacement-key-9876");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.CUSTOM_CREDENTIAL_UPDATED,
        after: { name: "GIPHY_API_KEY", platform: "WEB", valueChanged: true },
      })
    );
  });
});
