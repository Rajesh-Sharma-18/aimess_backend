/**
 * Admin update policy: the resolver ladder, the service's published-vs-static
 * policy source, the legacy response fields the shipped iOS client reads, and
 * the 426 refusal used by the REST gate and the socket handshake.
 */
import type { AppUpdatePolicy } from "@aimess/redis";

import { createAppVersionService } from "../../src/app-version/app-version.service.js";
import {
  DEFAULT_ANDROID_STORE,
  DEFAULT_IOS_STORE,
  fromLegacyConfig,
  resolveUpdateAction,
} from "../../src/app-version/resolve-update.js";
import type { AppVersionConfig } from "../../src/app-version/types.js";

const LEGACY: AppVersionConfig = {
  android: { mandatoryUpdate: "1.0.0", optionalUpdate: "1.2.0" },
  ios: { mandatoryUpdate: "1.0.0", optionalUpdate: "1.0.0" },
  updatedAt: new Date(0).toISOString(),
};

function policy(
  android: Partial<AppUpdatePolicy["android"]> = {},
  ios: Partial<AppUpdatePolicy["ios"]> = {}
): AppUpdatePolicy {
  const base = {
    mode: "ADMIN_MANAGED" as const,
    forceBelowVersion: "2.0.0",
    blockedVersions: [],
    latestVersion: "2.1.0",
    fullyRolledOut: true,
    minOsLevel: null,
    storeUrl: null,
    enforceOnServer: false,
    copy: {},
  };
  return {
    android: { ...base, store: DEFAULT_ANDROID_STORE, ...android },
    ios: { ...base, store: DEFAULT_IOS_STORE, ...ios },
    policyVersion: 7,
    updatedAt: new Date(0).toISOString(),
  };
}

function service(published: AppUpdatePolicy | null | Error, now = () => 1_000) {
  const store = { get: jest.fn(async () => LEGACY) };
  const read = jest.fn(async () => {
    if (published instanceof Error) throw published;
    return published;
  });
  return { svc: createAppVersionService(store, read, now), store, read };
}

describe("resolveUpdateAction", () => {
  const p = policy().android;

  it("forces below the force version", () => {
    expect(resolveUpdateAction(p, "1.9.9")).toEqual({
      action: "FORCE",
      reason: "BELOW_FORCE_VERSION",
    });
  });

  it("leaves the force version itself and above to the store", () => {
    expect(resolveUpdateAction(p, "2.0.0").action).toBe("STORE");
    expect(resolveUpdateAction(p, "3.0.0").action).toBe("STORE");
  });

  it("forces a blocked version even above the force version", () => {
    const blocked = { ...p, blockedVersions: ["2.0.5"] };
    expect(resolveUpdateAction(blocked, "2.0.5")).toEqual({
      action: "FORCE",
      reason: "BLOCKED_VERSION",
    });
  });

  it("store-managed forces nothing, rules ignored", () => {
    const store = { ...p, mode: "STORE_MANAGED" as const, blockedVersions: ["1.0.0"] };
    expect(resolveUpdateAction(store, "1.0.0").action).toBe("STORE");
  });

  it("an OS below the minimum is unsupported, ahead of every other rung", () => {
    const minOs = { ...p, minOsLevel: 26, mode: "STORE_MANAGED" as const };
    expect(resolveUpdateAction(minOs, "1.0.0", 24)).toEqual({
      action: "UNSUPPORTED_DEVICE",
      reason: "OS_TOO_OLD",
    });
  });

  describe("per-version rules", () => {
    const rule = (version: string, mode: "ADMIN_MANAGED" | "STORE_MANAGED", forceUpdate: boolean) => ({
      version,
      mode,
      forceUpdate,
      updatedAt: 1,
    });

    it("forces one version under a store-managed default", () => {
      const p2 = { ...p, mode: "STORE_MANAGED" as const, versionRules: [rule("2.0.3", "ADMIN_MANAGED", true)] };
      expect(resolveUpdateAction(p2, "2.0.3")).toEqual({ action: "FORCE", reason: "BLOCKED_VERSION" });
      expect(resolveUpdateAction(p2, "2.0.2").action).toBe("STORE");
    });

    it("a store-managed rule exempts its version from the default force floor", () => {
      const p2 = { ...p, versionRules: [rule("1.5.0", "STORE_MANAGED", false)] };
      expect(resolveUpdateAction(p2, "1.5.0")).toEqual({ action: "STORE", reason: "NONE" });
      expect(resolveUpdateAction(p2, "1.4.0").action).toBe("FORCE");
    });

    it("admin-managed without force leaves the version to the store", () => {
      const p2 = { ...p, versionRules: [rule("1.5.0", "ADMIN_MANAGED", false)] };
      expect(resolveUpdateAction(p2, "1.5.0").action).toBe("STORE");
    });

    it("matches versions numerically and still yields to the OS minimum", () => {
      const p2 = { ...p, minOsLevel: 26, versionRules: [rule("2.10.0", "ADMIN_MANAGED", true)] };
      expect(resolveUpdateAction(p2, "2.10.0").action).toBe("FORCE");
      expect(resolveUpdateAction(p2, "2.1.0").action).toBe("STORE");
      expect(resolveUpdateAction(p2, "2.10.0", 24).action).toBe("UNSUPPORTED_DEVICE");
    });

    it("the 426 refusal follows the rule, not the default", async () => {
      const published = policy({
        enforceOnServer: true,
        versionRules: [rule("1.5.0", "STORE_MANAGED", false)],
      });
      const { svc } = service(published);
      expect(await svc.refusal("android", "1.5.0")).toBeNull();
      expect(await svc.refusal("android", "1.4.0")).toMatchObject({ action: "FORCE" });
    });
  });

  it("an unreported OS never trips the minimum", () => {
    const minOs = { ...p, minOsLevel: 26 };
    expect(resolveUpdateAction(minOs, "2.0.0").action).toBe("STORE");
  });
});

describe("fromLegacyConfig", () => {
  it("keeps the static config's behaviour: force below mandatory, latest = optional", () => {
    const legacy = fromLegacyConfig(LEGACY);
    expect(legacy.android).toMatchObject({
      mode: "ADMIN_MANAGED",
      forceBelowVersion: "1.0.0",
      latestVersion: "1.2.0",
      enforceOnServer: false,
    });
  });
});

describe("createAppVersionService", () => {
  it("serves the published policy and the new fields", async () => {
    const { svc } = service(policy());
    const result = await svc.check({ platform: "android", version: "1.5.0" });
    expect(result).toMatchObject({
      action: "FORCE",
      reason: "BELOW_FORCE_VERSION",
      forceUpdate: true,
      optionalUpdate: false,
      isUpToDate: false,
      minimumRequiredVersion: "2.0.0",
      policyVersion: 7,
      store: DEFAULT_ANDROID_STORE,
    });
  });

  it("legacy optionalUpdate still fires for clients below latest that aren't forced", async () => {
    const { svc } = service(policy());
    const result = await svc.check({ platform: "ios", version: "2.0.1" });
    expect(result).toMatchObject({
      action: "STORE",
      forceUpdate: false,
      optionalUpdate: true,
      isUpToDate: false,
    });
  });

  it("store-managed reports no minimum to legacy clients", async () => {
    const { svc } = service(policy({ mode: "STORE_MANAGED" }));
    const result = await svc.check({ platform: "android", version: "1.0.0" });
    expect(result.minimumRequiredVersion).toBe("0.0.0");
    expect(result.forceUpdate).toBe(false);
  });

  it("falls back to the static policy when Redis fails", async () => {
    const { svc, store } = service(new Error("redis down"));
    const result = await svc.check({ platform: "android", version: "0.9.0" });
    expect(store.get).toHaveBeenCalled();
    expect(result.action).toBe("FORCE");
    expect(result.policyVersion).toBe(0);
  });

  it("picks copy for the request locale, then English", async () => {
    const copy = { en: { title: "Update" }, th: { title: "อัปเดต" } };
    const { svc } = service(policy({ copy }));
    expect((await svc.check({ platform: "android", version: "1.0.0", locale: "th" })).title).toBe("อัปเดต");
    expect((await svc.check({ platform: "android", version: "1.0.0", locale: "vi" })).title).toBe("Update");
  });

  it("caches the policy for 10 s, then re-reads", async () => {
    let t = 0;
    const { svc, read } = service(policy(), () => t);
    await svc.check({ platform: "android", version: "2.0.0" });
    t = 9_999;
    await svc.check({ platform: "android", version: "2.0.0" });
    expect(read).toHaveBeenCalledTimes(1);
    t = 10_000;
    await svc.check({ platform: "android", version: "2.0.0" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  describe("refusal", () => {
    it("refuses admin FORCE only when enforceOnServer is on", async () => {
      expect(await service(policy()).svc.refusal("android", "1.0.0")).toBeNull();
      const enforced = service(policy({ enforceOnServer: true })).svc;
      expect(await enforced.refusal("Android", "1.0.0")).toMatchObject({ action: "FORCE" });
      expect(await enforced.refusal("android", "2.0.0")).toBeNull();
    });

    it("fails open on missing or unparsable headers", async () => {
      const { svc } = service(policy({ enforceOnServer: true }));
      expect(await svc.refusal(undefined, "1.0.0")).toBeNull();
      expect(await svc.refusal("web", "1.0.0")).toBeNull();
      expect(await svc.refusal("android", undefined)).toBeNull();
      expect(await svc.refusal("android", "2.0.1-debug")).toBeNull();
    });
  });
});
