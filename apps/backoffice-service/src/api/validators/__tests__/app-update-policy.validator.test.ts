/**
 * The app update policy validator carries the admin safety rails: a force rule
 * must point at a version every forced user can install, store thresholds must
 * be ordered, and URLs/locales must be well-formed. Pure schema checks.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appUpdatePolicySchema } from "../system-maintenance.validator.js";

function platform(overrides: Record<string, unknown> = {}) {
  return {
    mode: "ADMIN_MANAGED",
    forceBelowVersion: "2.0.0",
    blockedVersions: ["2.0.5"],
    latestVersion: "2.1.0",
    fullyRolledOut: false,
    minOsLevel: 26,
    storeUrl: "market://details?id=com.aifivetech.aimess",
    enforceOnServer: false,
    copy: { en: { title: "Update available", message: "Please update." } },
    ...overrides,
  };
}

function policy(
  android: Record<string, unknown> = {},
  ios: Record<string, unknown> = {}
) {
  return {
    android: platform({
      store: { forceFromPriority: 4, softFromPriority: 2, escalateSoftAfterDays: 14 },
      ...android,
    }),
    ios: platform({
      storeUrl: "itms-apps://apps.apple.com/app/id123",
      store: { appStoreId: "123", forceOnBump: "MAJOR", softOnBump: "MINOR" },
      ...ios,
    }),
  };
}

const ok = (input: unknown) => appUpdatePolicySchema.safeParse(input).success;

describe("appUpdatePolicySchema", () => {
  it("accepts a well-formed policy", () => {
    assert.equal(ok(policy()), true);
  });

  it("accepts store-managed with no force version", () => {
    assert.equal(ok(policy({ mode: "STORE_MANAGED", forceBelowVersion: null })), true);
  });

  it("rejects forcing above the latest published version", () => {
    assert.equal(ok(policy({ forceBelowVersion: "3.0.0" })), false);
  });

  it("forcing below the latest version requires it to be fully rolled out", () => {
    assert.equal(ok(policy({ forceBelowVersion: "2.1.0", fullyRolledOut: false })), false);
    assert.equal(ok(policy({ forceBelowVersion: "2.1.0", fullyRolledOut: true })), true);
  });

  it("compares versions numerically, not as strings", () => {
    assert.equal(ok(policy({ forceBelowVersion: "2.9.0", latestVersion: "2.10.0" })), true);
  });

  it("rejects a soft priority threshold above the force threshold", () => {
    assert.equal(
      ok(policy({ store: { forceFromPriority: 2, softFromPriority: 4, escalateSoftAfterDays: null } })),
      false
    );
  });

  it("rejects priorities outside Play's 0–5", () => {
    assert.equal(
      ok(policy({ store: { forceFromPriority: 6, softFromPriority: 2, escalateSoftAfterDays: null } })),
      false
    );
  });

  it("iOS force bump must be larger than the soft bump", () => {
    const store = (forceOnBump: string, softOnBump: string) =>
      policy({}, { store: { appStoreId: "123", forceOnBump, softOnBump } });
    assert.equal(ok(store("MINOR", "MINOR")), false);
    assert.equal(ok(store("MINOR", "MAJOR")), false);
    assert.equal(ok(store("MAJOR", "PATCH")), true);
    assert.equal(ok(store("OFF", "MINOR")), true);
  });

  it("rejects malformed versions and store URLs", () => {
    assert.equal(ok(policy({ latestVersion: "2.1" })), false);
    assert.equal(ok(policy({ blockedVersions: ["v2.0.5"] })), false);
    assert.equal(ok(policy({ storeUrl: "javascript:alert(1)" })), false);
    assert.equal(ok(policy({ storeUrl: "http://example.com/app.apk" })), false);
  });

  it("rejects copy keyed by anything but a 2-letter locale", () => {
    assert.equal(ok(policy({ copy: { english: { title: "x" } } })), false);
  });

  describe("versionRules", () => {
    const rule = (version: string, mode = "ADMIN_MANAGED", forceUpdate = true) => ({
      version,
      mode,
      forceUpdate,
    });

    it("is optional, so an older admin client still validates", () => {
      assert.equal(ok(policy()), true);
    });

    it("accepts default + specific rules in every mode combination", () => {
      const versionRules = [
        rule("2.0.3"),
        rule("2.0.2", "ADMIN_MANAGED", false),
        rule("1.9.0", "STORE_MANAGED", false),
      ];
      assert.equal(ok(policy({ mode: "STORE_MANAGED", versionRules })), true);
      assert.equal(ok(policy({ mode: "ADMIN_MANAGED", versionRules })), true);
    });

    it("rejects the same version twice, compared numerically", () => {
      assert.equal(ok(policy({ versionRules: [rule("2.0.3"), rule("02.0.3", "STORE_MANAGED", false)] })), false);
    });

    it("rejects forcing a version that is not below the latest", () => {
      assert.equal(ok(policy({ versionRules: [rule("2.1.0")] })), false);
      // Not forced: no newer version is needed.
      assert.equal(ok(policy({ versionRules: [rule("2.1.0", "STORE_MANAGED", false)] })), true);
    });

    it("rejects malformed rule versions", () => {
      assert.equal(ok(policy({ versionRules: [rule("2.0")] })), false);
    });
  });

  it("requires both platforms", () => {
    assert.equal(ok({ android: policy().android }), false);
  });
});
