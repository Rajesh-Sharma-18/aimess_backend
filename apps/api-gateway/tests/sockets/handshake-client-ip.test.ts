/**
 * AIM-08 / AIM-35 / AIM-37 — the client address must come from the hop the
 * trusted proxy appended, never from the leftmost entry the caller typed.
 *
 * Express gives REST routes this for free through `req.ip` once
 * `app.set("trust proxy", n)` is applied. Socket.IO handshakes have no `req`,
 * so the gateway does the hop counting itself in `bindSocketAuditContext` —
 * and that is the copy that used to take `split(",")[0]` unconditionally, which
 * put an attacker-chosen address on every socket-originated audit row.
 *
 * TRUST_PROXY_HOPS is read at import, so each case re-imports the module under
 * a patched environment.
 */
import type { Socket } from "socket.io";

type Handshake = {
  headers: Record<string, string | string[] | undefined>;
  address: string;
  query: Record<string, unknown>;
};

/**
 * Drive `bindSocketAuditContext` with `hops` trusted proxies and return the
 * audit context it established for an inbound packet.
 */
async function contextFor(
  hops: number,
  handshake: Partial<Handshake>
): Promise<{ ip: string | null; source: string }> {
  const original = process.env.TRUST_PROXY_HOPS;
  process.env.TRUST_PROXY_HOPS = String(hops);

  let captured: { ip: string | null; source: string } | undefined;

  try {
    await jest.isolateModulesAsync(async () => {
      const { bindSocketAuditContext } = await import(
        "../../src/sockets/audit-context.js"
      );
      const { currentAuditContext } = await import("@aimess/constants");

      let middleware: ((packet: unknown[], next: () => void) => void) | null =
        null;

      const socket = {
        handshake: {
          headers: handshake.headers ?? {},
          address: handshake.address ?? "10.0.0.9",
          query: handshake.query ?? {},
        },
        use(fn: (packet: unknown[], next: () => void) => void) {
          middleware = fn;
        },
      } as unknown as Socket;

      bindSocketAuditContext(socket);

      // Re-enter the context the way an inbound packet would.
      (middleware as unknown as (p: unknown[], n: () => void) => void)(
        ["message:send", {}],
        () => {
          const ctx = currentAuditContext();
          captured = { ip: ctx?.ip ?? null, source: String(ctx?.source) };
        }
      );
    });
  } finally {
    if (original === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = original;
  }

  if (!captured) throw new Error("audit context was never established");
  return captured;
}

describe("socket handshake client IP", () => {
  it("ignores X-Forwarded-For entirely when no proxy is trusted", async () => {
    const ctx = await contextFor(0, {
      headers: { "x-forwarded-for": "203.0.113.10" },
      address: "10.0.0.9",
    });

    expect(ctx.ip).toBe("10.0.0.9");
  });

  it("takes the hop the trusted proxy appended, not the client's entry", async () => {
    // The attacker sent "203.0.113.10"; the proxy appended the real address.
    // The leftmost entry is the forged one — which is what the old code used.
    const ctx = await contextFor(1, {
      headers: { "x-forwarded-for": "203.0.113.10, 198.51.100.7" },
      address: "10.0.0.9",
    });

    expect(ctx.ip).toBe("198.51.100.7");
    expect(ctx.ip).not.toBe("203.0.113.10");
  });

  it("counts from the right with two trusted proxies", async () => {
    const ctx = await contextFor(2, {
      headers: {
        "x-forwarded-for": "203.0.113.10, 198.51.100.7, 198.51.100.8",
      },
    });

    expect(ctx.ip).toBe("198.51.100.7");
  });

  it("does not read past the start of a shorter-than-expected chain", async () => {
    // Fewer hops than configured means the request did not traverse the proxies
    // we expect; fall back to the leftmost entry present rather than undefined.
    const ctx = await contextFor(3, {
      headers: { "x-forwarded-for": "203.0.113.10" },
      address: "10.0.0.9",
    });

    expect(ctx.ip).toBe("203.0.113.10");
  });

  it("falls back to the socket address when the header is absent or empty", async () => {
    expect((await contextFor(1, { address: "10.0.0.9" })).ip).toBe("10.0.0.9");
    expect(
      (
        await contextFor(1, {
          headers: { "x-forwarded-for": "" },
          address: "10.0.0.9",
        })
      ).ip
    ).toBe("10.0.0.9");
  });

  it("never derives ADMIN_PANEL from the handshake (AIM-37)", async () => {
    // Neither the header nor the query string may claim the admin panel.
    const viaHeader = await contextFor(0, {
      headers: { "x-platform": "admin_panel" },
    });
    const viaQuery = await contextFor(0, {
      query: { platform: "admin_panel" },
    });

    expect(viaHeader.source).not.toBe("ADMIN_PANEL");
    expect(viaQuery.source).not.toBe("ADMIN_PANEL");
  });
});
