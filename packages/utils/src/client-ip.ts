import { buildIpAllowList } from "./ip-allowlist";

// https://www.cloudflare.com/ips/ (ips-v4 + ips-v6). Refresh when Cloudflare publishes a change.
export const CLOUDFLARE_IP_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

const cloudflare = buildIpAllowList(CLOUDFLARE_IP_RANGES);

export function isCloudflareIp(ip: string): boolean {
  return cloudflare?.check(ip) ?? false;
}

/**
 * Express `trust proxy` for every service: the first `hops` proxies (nginx) plus any Cloudflare edge
 * in the chain. With the hop count alone `req.ip` was the Cloudflare edge that nginx appended to
 * X-Forwarded-For, so sessions, login notifications and per-IP limits all saw Cloudflare instead of
 * the user. The edge is only trusted behind a configured proxy (hops > 0).
 */
export function trustProxyHops(hops: number): (addr: string, hop: number) => boolean {
  return (addr, hop) => hop < hops || (hops > 0 && isCloudflareIp(addr));
}

/** [trustProxyHops] over a raw chain, for callers without Express's `req.ip` (Socket.IO handshakes). */
export function resolveForwardedIp(
  peer: string,
  forwardedFor: string | undefined,
  hops: number
): string {
  const trust = trustProxyHops(hops);
  const chain = [
    peer,
    ...(forwardedFor ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .reverse(),
  ];
  for (let hop = 0; hop < chain.length - 1; hop++) {
    if (!trust(chain[hop], hop)) return chain[hop];
  }
  return chain[chain.length - 1];
}
