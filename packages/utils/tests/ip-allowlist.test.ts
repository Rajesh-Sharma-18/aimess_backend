/**
 * Admin source-address allowlist — parser, matcher, and the production boot
 * check both admin perimeters share.
 *
 * The matcher had no test at all, which is how `buildIpAllowList` came to
 * return null for a list whose every entry was malformed. Null means "no
 * restriction" to both callers, so a single typo in `ADMIN_IP_WHITELIST` —
 * `203.0.113.0/33` is enough — turned the whole `/admin` surface, including the
 * unauthenticated login and password-reset paths, into an open one. The
 * emptiness check in each service's `env.ts` could not see it: the list was not
 * empty, it just parsed to nothing.
 *
 * The parser keeps that fail-open behaviour on purpose (a dev box must not be
 * bricked by a typo); `adminIpWhitelistFailures` is what refuses the production
 * boot, so a misconfiguration can never be the thing that removes the control.
 */
import {
  adminIpWhitelistFailures,
  buildIpAllowList,
  isAllowAllIpRule,
  normalizeIp,
} from "../src/ip-allowlist.js";

describe("buildIpAllowList — matching", () => {
  it("matches a literal IPv4 address and nothing else", () => {
    const list = buildIpAllowList(["203.0.113.10"]);
    expect(list?.check("203.0.113.10")).toBe(true);
    expect(list?.check("203.0.113.11")).toBe(false);
  });

  it("matches an IPv4 CIDR range", () => {
    const list = buildIpAllowList(["198.51.100.0/24"]);
    expect(list?.check("198.51.100.1")).toBe(true);
    expect(list?.check("198.51.100.255")).toBe(true);
    expect(list?.check("198.51.101.1")).toBe(false);
  });

  it("matches an IPv4 rule against a dual-stack ::ffff: peer address", () => {
    // How a dual-stack listener reports an IPv4 client. Without normalization
    // every rule would miss every request behind such a listener.
    const list = buildIpAllowList(["203.0.113.10"]);
    expect(list?.check("::ffff:203.0.113.10")).toBe(true);
  });

  it("matches IPv6 literals and ranges", () => {
    const list = buildIpAllowList(["2001:db8::1", "2001:db8:1::/48"]);
    expect(list?.check("2001:db8::1")).toBe(true);
    expect(list?.check("2001:db8:1::99")).toBe(true);
    expect(list?.check("2001:db8:2::1")).toBe(false);
  });

  it("keeps the valid entries when the list is mixed", () => {
    const rejected: string[] = [];
    const list = buildIpAllowList(
      ["203.0.113.10", "203.0.113.0/33", "not-an-ip"],
      (entry) => rejected.push(entry)
    );

    expect(list?.check("203.0.113.10")).toBe(true);
    expect(list?.check("198.51.100.1")).toBe(false);
    expect(rejected).toEqual(["203.0.113.0/33", "not-an-ip"]);
  });

  it("returns null for an empty list — the historical 'no restriction'", () => {
    expect(buildIpAllowList([])).toBeNull();
  });

  it("returns null when every entry is malformed, and says so", () => {
    // The finding. Enforcing an empty rule set would deny the whole admin
    // surface over a typo, so the parser opens — and the boot check below is
    // what stops that ever being production's state.
    const reasons: string[] = [];
    const list = buildIpAllowList(
      ["203.0.113.0/33", "999.1.1.1", "1.2.3.4/abc"],
      (_entry, reason) => reasons.push(reason)
    );

    expect(list).toBeNull();
    expect(reasons.at(-1)).toContain("no usable entries");
  });

  it("obeys 0.0.0.0/0 and ::/0 as written", () => {
    // Faithful matching: silently narrowing what the operator wrote would be
    // worse than obeying it. The refusal is a boot-time decision, not here.
    expect(buildIpAllowList(["0.0.0.0/0"])?.check("203.0.113.9")).toBe(true);
    expect(buildIpAllowList(["::/0"])?.check("2001:db8::1")).toBe(true);
  });

  it("does not let an IPv4 allow-all rule admit an IPv6 caller", () => {
    // The two families are separate BlockList rule sets — `0.0.0.0/0` is
    // allow-all for v4 only, and a v6 peer must still be refused.
    const list = buildIpAllowList(["0.0.0.0/0"]);
    expect(list?.check("2001:db8::1")).toBe(false);
  });

  it("refuses an address that is neither v4 nor v6", () => {
    const list = buildIpAllowList(["203.0.113.10"]);
    expect(list?.check("")).toBe(false);
    expect(list?.check("localhost")).toBe(false);
  });
});

describe("normalizeIp", () => {
  it("unwraps ::ffff: mapped addresses and leaves everything else alone", () => {
    expect(normalizeIp("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIp(" 203.0.113.5 ")).toBe("203.0.113.5");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });
});

describe("isAllowAllIpRule", () => {
  it("recognises a zero-length prefix in either family", () => {
    expect(isAllowAllIpRule("0.0.0.0/0")).toBe(true);
    expect(isAllowAllIpRule("::/0")).toBe(true);
  });

  it("does not fire on ordinary rules or on a bare address", () => {
    expect(isAllowAllIpRule("198.51.100.0/24")).toBe(false);
    expect(isAllowAllIpRule("203.0.113.10")).toBe(false);
    expect(isAllowAllIpRule("0.0.0.0")).toBe(false);
  });
});

describe("adminIpWhitelistFailures — the production boot invariant", () => {
  it("passes a list of valid addresses and ranges", () => {
    expect(
      adminIpWhitelistFailures(["203.0.113.10", "198.51.100.0/24"])
    ).toEqual([]);
  });

  it("passes a mixed list, because usable rules remain", () => {
    // Deliberate: one bad entry among good ones still leaves an enforced
    // perimeter, and the guard logs each rejection at boot.
    expect(adminIpWhitelistFailures(["203.0.113.10", "nonsense"])).toEqual([]);
  });

  it("refuses a list whose entries are all malformed", () => {
    const failures = adminIpWhitelistFailures(["203.0.113.0/33", "nonsense"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("no usable entries");
    expect(failures[0]).toContain("203.0.113.0/33");
  });

  it("refuses an empty list", () => {
    const failures = adminIpWhitelistFailures([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("empty");
  });

  it("refuses an explicit allow-all, which is the empty list by another name", () => {
    expect(adminIpWhitelistFailures(["0.0.0.0/0"])[0]).toContain(
      "matches every address"
    );
    expect(adminIpWhitelistFailures(["::/0"])[0]).toContain(
      "matches every address"
    );
  });

  it("refuses allow-all even when real ranges are listed alongside it", () => {
    const failures = adminIpWhitelistFailures(["198.51.100.0/24", "0.0.0.0/0"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("0.0.0.0/0");
  });
});
