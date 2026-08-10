/**
 * Friendship events must reach ONLY the two people involved.
 *
 * They are published on the Redis channel `user:<userId>`, but the Socket.IO
 * room of the same name is also joined by anyone who called
 * `presence:subscribe` on that user — and the web client subscribes to every DM
 * peer it has. So a bystander who merely shares a conversation with the
 * addressee was receiving that user's friend requests, and (via
 * `conversation:pending-friend-request`, which carries the requester's name,
 * username and avatar) rendering a pending request row addressed to someone
 * else.
 *
 * A = requester, B = addressee, C = bystander watching B's presence.
 *
 *   BASE_URL=http://localhost:3000 npx tsx scripts/verify-friend-event-isolation.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
   A probe script that asserts on raw socket payloads; declaring every shape
   would add ceremony, not safety. */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PASSWORD = "PrivacyProbe!2026";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") =>
  results.push({ name, ok, detail });

type Json = Record<string, any>;
type Actor = { account: string; userId: string; token: string };

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  } catch {
    return { status: res.status, body: { raw: text } };
  }
}

async function makeActor(suffix: string): Promise<Actor> {
  const account = `zzfe_${suffix}_${Date.now().toString(36)}`;
  const reg = await api("POST", "/api/v1/auth/register", {
    body: { account, password: PASSWORD },
  });
  if (reg.status >= 300) {
    throw new Error(
      `register ${account}: ${reg.status} ${JSON.stringify(reg.body)}`
    );
  }
  const data = reg.body.data ?? reg.body;
  const token = data.accessToken ?? data.tokens?.accessToken;
  const userId =
    data.userId ??
    data.user?.id ??
    JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  for (let i = 0; i < 20; i++) {
    const p = await api("PATCH", "/api/v1/users/profiles/me", {
      token,
      body: {
        firstName: "Isolation",
        lastName: "Probe",
        username: account.toLowerCase(),
        dateOfBirth: "1995-06-15",
        gender: "MALE",
      },
    });
    if (p.status < 300) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { account, userId, token };
}

async function connect(token: string) {
  const mod: any = await import("socket.io-client").catch(
    () =>
      import("../../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm/index.js")
  );
  const io = mod.io ?? mod.default?.io ?? mod.default;
  const socket = io(`${BASE}/chat`, {
    auth: { token },
    transports: ["websocket", "polling"],
    reconnection: false,
  });
  const ok = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 15000);
    socket.on("connect", () => (clearTimeout(t), resolve(true)));
    socket.on("connect_error", () => (clearTimeout(t), resolve(false)));
  });
  return ok ? socket : null;
}

/** Record every friendship-shaped event a socket receives, with its name. */
function recordFriendEvents(socket: any): {
  seen: { event: string; data: Json }[];
} {
  const seen: { event: string; data: Json }[] = [];
  socket.onAny((event: string, data: Json) => {
    if (event.startsWith("friend:") || event.startsWith("conversation:")) {
      seen.push({ event, data });
    }
  });
  return { seen };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health?.ok) {
    console.log(`SKIP  no stack at ${BASE}`);
    return;
  }

  const [requester, addressee, bystander] = await Promise.all([
    makeActor("requester"),
    makeActor("addressee"),
    makeActor("bystander"),
  ]);

  // The bystander can only join `user:<addressee>` if the addressee's presence
  // scope admits them — that is exactly the situation the leak needs.
  await api("PATCH", "/api/v1/users/settings/me", {
    token: addressee.token,
    body: { privacy: { whoCanSeeOnlineStatus: "EVERYONE" } },
  });

  const addresseeSocket = await connect(addressee.token);
  const bystanderSocket = await connect(bystander.token);
  if (!addresseeSocket || !bystanderSocket) {
    check("probe sockets connected", false, "handshake failed");
    report();
    return;
  }

  const addresseeEvents = recordFriendEvents(addresseeSocket);
  const bystanderEvents = recordFriendEvents(bystanderSocket);

  const ack = await new Promise<Json | null>((resolve) => {
    bystanderSocket.emit(
      "presence:subscribe",
      { peerIds: [addressee.userId] },
      (res: Json) => resolve(res)
    );
    setTimeout(() => resolve(null), 5000);
  });
  check(
    "bystander is watching the addressee's presence (the leak's precondition)",
    (ack as any)?.data?.subscribedCount === 1,
    JSON.stringify(ack)?.slice(0, 120)
  );

  const sent = await api("POST", "/api/v1/users/friends/requests", {
    token: requester.token,
    body: { addresseeId: addressee.userId },
  });
  check(
    "friend request accepted by the API",
    sent.status < 300,
    `status ${sent.status}`
  );
  await wait(2500);

  check(
    "the ADDRESSEE receives the friend request on their own socket",
    addresseeEvents.seen.length > 0,
    addresseeEvents.seen.map((e) => e.event).join(", ") || "nothing"
  );
  check(
    "the BYSTANDER receives NOTHING about it",
    bystanderEvents.seen.length === 0,
    bystanderEvents.seen.map((e) => e.event).join(", ") || "silent"
  );

  // Accepting moves both parties' state — the same relay, so the same risk.
  const friendshipId = (sent.body?.data as Json)?.id;
  if (friendshipId) {
    addresseeEvents.seen.length = 0;
    bystanderEvents.seen.length = 0;
    const accepted = await api(
      "POST",
      `/api/v1/users/friends/requests/${friendshipId}/accept`,
      { token: addressee.token }
    );
    await wait(2500);
    check(
      "accept reaches the addressee's own socket",
      accepted.status < 300 && addresseeEvents.seen.length > 0,
      addresseeEvents.seen.map((e) => e.event).join(", ") || "nothing"
    );
    check(
      "…and still nothing reaches the bystander",
      bystanderEvents.seen.length === 0,
      bystanderEvents.seen.map((e) => e.event).join(", ") || "silent"
    );
  }

  addresseeSocket.disconnect();
  bystanderSocket.disconnect();
  report();
  console.log(
    `probe accounts: ${requester.account}, ${addressee.account}, ${bystander.account}`
  );
}

function report() {
  let pass = 0;
  for (const r of results) {
    if (r.ok) pass++;
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`
    );
  }
  console.log(`${pass}/${results.length} passed`);
  if (pass !== results.length) process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
