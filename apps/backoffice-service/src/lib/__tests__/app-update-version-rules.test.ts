/**
 * Per-version update rules: `versionRules` is the source of truth, and
 * `blockedVersions` is re-derived from it so a gateway that predates rules still
 * forces the same versions. An admin client that predates rules (sends only
 * blockedVersions) must keep its old meaning.
 *
 * Run via `tsx --test "src/lib/__tests__/app-update-version-rules.test.ts"`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rulesOf, withVersionRules } from "../app-update-version-rules.js";

const base = {
  mode: "STORE_MANAGED" as const,
  forceBelowVersion: null,
  blockedVersions: [] as string[],
  latestVersion: "3.0.0",
  fullyRolledOut: true,
  minOsLevel: null,
  storeUrl: null,
  enforceOnServer: false,
  copy: {},
  store: {
    forceFromPriority: 4,
    softFromPriority: 2,
    escalateSoftAfterDays: null,
  },
};

describe("withVersionRules", () => {
  it("derives blockedVersions from the forced rules only, newest first", () => {
    const out = withVersionRules(
      {
        ...base,
        blockedVersions: ["9.9.9"],
        versionRules: [
          { version: "2.0.1", mode: "ADMIN_MANAGED", forceUpdate: true },
          { version: "2.10.0", mode: "STORE_MANAGED", forceUpdate: false },
          { version: "2.9.0", mode: "ADMIN_MANAGED", forceUpdate: false },
        ],
      },
      undefined,
      0,
      500
    );
    assert.deepEqual(out.blockedVersions, ["2.0.1"]);
    assert.deepEqual(
      out.versionRules.map((r) => r.version),
      ["2.10.0", "2.9.0", "2.0.1"]
    );
    assert.ok(out.versionRules.every((r) => r.updatedAt === 500));
  });

  it("a store-managed rule never carries force", () => {
    const out = withVersionRules(
      {
        ...base,
        versionRules: [
          { version: "2.0.0", mode: "STORE_MANAGED", forceUpdate: true },
        ],
      },
      undefined,
      0,
      1
    );
    assert.equal(out.versionRules[0].forceUpdate, false);
    assert.deepEqual(out.blockedVersions, []);
  });

  it("keeps updatedAt for an unchanged rule and stamps a changed one", () => {
    const previous = {
      ...base,
      versionRules: [
        {
          version: "2.0.0",
          mode: "ADMIN_MANAGED" as const,
          forceUpdate: true,
          updatedAt: 100,
        },
        {
          version: "2.1.0",
          mode: "ADMIN_MANAGED" as const,
          forceUpdate: true,
          updatedAt: 100,
        },
      ],
    };
    const out = withVersionRules(
      {
        ...base,
        versionRules: [
          {
            version: "2.0.0",
            mode: "ADMIN_MANAGED",
            forceUpdate: true,
            updatedAt: 1,
          },
          { version: "02.1.0", mode: "STORE_MANAGED", forceUpdate: false },
        ],
      },
      previous,
      0,
      900
    );
    const byVersion = Object.fromEntries(
      out.versionRules.map((r) => [r.version, r.updatedAt])
    );
    assert.deepEqual(byVersion, { "2.0.0": 100, "2.1.0": 900 });
  });

  it("an older admin client that sends only blockedVersions keeps them forced", () => {
    const out = withVersionRules(
      { ...base, blockedVersions: ["2.0.5"] },
      undefined,
      0,
      7
    );
    assert.deepEqual(out.versionRules, [
      {
        version: "2.0.5",
        mode: "ADMIN_MANAGED",
        forceUpdate: true,
        updatedAt: 7,
      },
    ]);
    assert.deepEqual(out.blockedVersions, ["2.0.5"]);
  });
});

describe("rulesOf", () => {
  it("reads a pre-rules policy's blocked versions as forced rules", () => {
    assert.deepEqual(rulesOf({ ...base, blockedVersions: ["1.2.3"] }, 42), [
      {
        version: "1.2.3",
        mode: "ADMIN_MANAGED",
        forceUpdate: true,
        updatedAt: 42,
      },
    ]);
  });

  it("prefers stored rules when present", () => {
    const versionRules = [
      {
        version: "1.0.0",
        mode: "STORE_MANAGED" as const,
        forceUpdate: false,
        updatedAt: 5,
      },
    ];
    assert.equal(
      rulesOf({ ...base, blockedVersions: ["9.0.0"], versionRules }, 42),
      versionRules
    );
  });
});
