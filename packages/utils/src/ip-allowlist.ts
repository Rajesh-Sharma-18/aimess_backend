import { BlockList, isIPv4, isIPv6 } from "node:net";

/**
 * Source-address allowlist matching for the admin surface.
 *
 * Both api-gateway and backoffice-service guard `/admin/*` with the same
 * `ADMIN_IP_WHITELIST` list, and both compared it with `allowlist.includes(ip)`
 * — an exact string match — while the env template documented the key as
 * "comma-separated CIDRs". So any mask matched nothing and silently 403'd every
 * admin request, and `0.0.0.0/0` read as allow-all but denied everyone.
 *
 * Lives here rather than in either service so the two guards cannot drift.
 */

/**
 * `::ffff:203.0.113.5` is how a dual-stack listener reports an IPv4 peer, so an
 * IPv4 rule has to match it. Applied to rules and request addresses alike.
 */
export function normalizeIp(raw: string): string {
  const value = raw.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return mapped ? mapped[1] : value;
}

export interface IpAllowList {
  /** True when the address matches any configured rule. */
  check(ip: string): boolean;
}

/**
 * Builds a matcher from literal addresses (`203.0.113.10`) and/or CIDR ranges
 * (`198.51.100.0/24`, `0.0.0.0/0`), v4 or v6.
 *
 * Returns null when nothing usable is configured — which callers must treat as
 * "no restriction", the meaning an empty list has always had. That includes the
 * case where every entry was malformed: enforcing an empty rule set would deny
 * the entire admin surface over a typo, a far worse outcome than the misconfig,
 * so `onInvalid` is called for each bad entry and the guard opens.
 */
export function buildIpAllowList(
  entries: string[],
  onInvalid?: (entry: string, reason: string) => void
): IpAllowList | null {
  if (entries.length === 0) return null;

  const list = new BlockList();
  let rules = 0;

  for (const entry of entries) {
    const slash = entry.indexOf("/");

    if (slash === -1) {
      const ip = normalizeIp(entry);
      if (isIPv4(ip)) list.addAddress(ip, "ipv4");
      else if (isIPv6(ip)) list.addAddress(ip, "ipv6");
      else {
        onInvalid?.(entry, "not a valid address");
        continue;
      }
      rules += 1;
      continue;
    }

    const net = normalizeIp(entry.slice(0, slash));
    const prefix = Number(entry.slice(slash + 1));

    if (!Number.isInteger(prefix) || prefix < 0) {
      onInvalid?.(entry, "prefix is not a non-negative integer");
      continue;
    }
    if (isIPv4(net) && prefix <= 32) list.addSubnet(net, prefix, "ipv4");
    else if (isIPv6(net) && prefix <= 128) list.addSubnet(net, prefix, "ipv6");
    else {
      onInvalid?.(entry, "not a valid CIDR range");
      continue;
    }
    rules += 1;
  }

  if (rules === 0) {
    onInvalid?.("<all entries>", "no usable entries; treating as unrestricted");
    return null;
  }

  return {
    check(raw: string): boolean {
      const ip = normalizeIp(raw);
      if (isIPv4(ip)) return list.check(ip, "ipv4");
      if (isIPv6(ip)) return list.check(ip, "ipv6");
      return false;
    },
  };
}

/**
 * True for a rule that matches every address of its family — `0.0.0.0/0` or
 * `::/0`, and any other zero-length prefix.
 *
 * `buildIpAllowList` matches these faithfully, because a zero prefix is what
 * the operator wrote and silently narrowing it would be worse than obeying it.
 * But on the admin perimeter it produces exactly the state the boot invariant
 * already refuses for an EMPTY list — "reachable from any address" — so the
 * production assertions reject it there too, loudly, rather than letting the
 * two spellings of allow-all disagree.
 */
export function isAllowAllIpRule(entry: string): boolean {
  const slash = entry.indexOf("/");
  if (slash === -1) return false;
  const net = normalizeIp(entry.slice(0, slash));
  const prefix = Number(entry.slice(slash + 1));
  return prefix === 0 && (isIPv4(net) || isIPv6(net));
}

/**
 * Production boot check for `ADMIN_IP_WHITELIST`, shared by api-gateway and
 * backoffice-service so the two admin perimeters cannot disagree. Returns one
 * message per problem; an empty array means the list is safe to enforce.
 *
 * Three ways the admin surface ends up reachable from anywhere, all of which
 * have to refuse the boot rather than warn:
 *
 *  - the list is empty — the long-standing case, already refused;
 *  - every entry is malformed (`203.0.113.0/33`, a typo'd address), which makes
 *    `buildIpAllowList` return null and the guard open. A misconfiguration must
 *    never be the thing that removes the control;
 *  - an entry is an explicit `0.0.0.0/0` or `::/0`, which is allow-all spelled
 *    out. It matches faithfully everywhere else — dev and staging may want
 *    it — but on this perimeter it is the same outcome as an empty list.
 */
export function adminIpWhitelistFailures(entries: string[]): string[] {
  if (entries.length === 0) {
    return [
      "ADMIN_IP_WHITELIST is empty — an empty list means allow-all, so the whole /admin surface (including the unauthenticated login and password-reset paths) would be reachable from any address.",
    ];
  }

  const failures: string[] = [];
  const invalid: string[] = [];

  // Only real entries — `buildIpAllowList` also reports a synthetic
  // "<all entries>" summary line, which would read as a rejected value here.
  const isRealEntry = (entry: string): boolean => entries.includes(entry);

  if (
    buildIpAllowList(entries, (entry) => {
      if (isRealEntry(entry)) invalid.push(entry);
    }) === null
  ) {
    failures.push(
      `ADMIN_IP_WHITELIST has no usable entries (rejected: ${invalid.join(", ")}) — a list that parses to nothing is treated as no restriction, so the /admin surface would be reachable from any address.`
    );
  }

  const allowAll = entries.filter(isAllowAllIpRule);
  if (allowAll.length > 0) {
    failures.push(
      `ADMIN_IP_WHITELIST contains ${allowAll.join(", ")}, which matches every address — the /admin surface (including the unauthenticated login and password-reset paths) would be reachable from anywhere. Use the operator networks explicitly.`
    );
  }

  return failures;
}
