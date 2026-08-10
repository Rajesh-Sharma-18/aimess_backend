/**
 * Does a privacy change reach OTHER users' open sockets, with no refresh,
 * reconnect or re-subscribe?
 *
 * `verify-privacy-e2e.ts` proves the backend ENFORCES the new scope on the next
 * read. That is not the same question: a watcher whose subscription is revoked
 * silently keeps a stale green dot on screen, because the room it was removed
 * from is the only thing that would ever have corrected it. And a watcher who
 * was denied at subscribe time never rejoins when the subject widens the scope.
 *
 * Both directions have to arrive as a pushed `presence:status`:
 *
 *   EVERYONE → NO_ONE   watcher must be told the subject is offline
 *   NO_ONE   → EVERYONE watcher must be told the subject is online again,
 *                       WITHOUT re-subscribing
 *
 *   BASE_URL=http://localhost:3000 npx tsx scripts/verify-privacy-realtime.ts
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
  const account = `zzrt_${suffix}_${Date.now().toString(36)}`;
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
  // The user_profiles row is written by an async consumer, so retry rather than
  // assume the event has landed.
  for (let i = 0; i < 20; i++) {
    const p = await api("PATCH", "/api/v1/users/profiles/me", {
      token,
      body: {
        firstName: "Realtime",
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

const setPrivacy = async (actor: Actor, patch: Json) => {
  const res = await api("PATCH", "/api/v1/users/settings/me", {
    token: actor.token,
    body: { privacy: patch },
  });
  if (res.status >= 300) {
    throw new Error(`PATCH ${JSON.stringify(patch)}: ${res.status}`);
  }
};

async function io() {
  const mod: any = await import("socket.io-client").catch(
    () =>
      import("../../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm/index.js")
  );
  return mod.io ?? mod.default?.io ?? mod.default;
}

async function connect(token: string) {
  const ioFn = await io();
  const socket = ioFn(`${BASE}/chat`, {
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

/**
 * Wait for a `presence:status` about `subjectId` that satisfies `want`, or null
 * on timeout. Matching on the payload rather than on "the next event" matters:
 * the subject is heartbeating throughout, so an unrelated online bump can land
 * between the PATCH and the event under test and would fail a strict next-event
 * assertion for the wrong reason.
 */
function nextStatus(
  socket: any,
  subjectId: string,
  want: (p: Json) => boolean = () => true,
  ms = 8000
) {
  return new Promise<Json | null>((resolve) => {
    const timer = setTimeout(() => {
      socket.off("presence:status", handler);
      resolve(null);
    }, ms);
    const handler = (p: Json) => {
      if (p?.userId !== subjectId || !want(p)) return;
      clearTimeout(timer);
      socket.off("presence:status", handler);
      resolve(p);
    };
    socket.on("presence:status", handler);
  });
}

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health?.ok) {
    console.log(`SKIP  no stack at ${BASE}`);
    return;
  }

  const subject = await makeActor("subject");
  const watcher = await makeActor("watcher");
  await setPrivacy(subject, { whoCanSeeOnlineStatus: "EVERYONE" });

  const subjectSocket = await connect(subject.token);
  const watcherSocket = await connect(watcher.token);
  if (!subjectSocket || !watcherSocket) {
    check("both probe sockets connected", false, "handshake failed");
    report();
    return;
  }
  subjectSocket.emit("presence:heartbeat", { appState: "FOREGROUND" });
  const beat = setInterval(
    () => subjectSocket.emit("presence:heartbeat", { appState: "FOREGROUND" }),
    2000
  );

  // Subscribe ONCE. Everything after this must arrive without the client
  // asking again — that is the whole point of the test.
  const ack = await new Promise<Json | null>((resolve) => {
    watcherSocket.emit(
      "presence:subscribe",
      { peerIds: [subject.userId] },
      (res: Json) => resolve(res)
    );
    setTimeout(() => resolve(null), 5000);
  });
  check(
    "watcher subscribed while the scope still allowed it",
    Boolean(ack),
    JSON.stringify(ack)?.slice(0, 120)
  );

  // --- narrowing: EVERYONE → NO_ONE ---------------------------------------
  const offlinePush = nextStatus(
    watcherSocket,
    subject.userId,
    (p) => p.isOnline === false
  );
  await setPrivacy(subject, { whoCanSeeOnlineStatus: "NO_ONE" });
  const off = await offlinePush;
  check(
    "EVERYONE → NO_ONE pushes presence:status offline to the watcher",
    off !== null,
    off ? JSON.stringify(off) : "no offline event within 8s"
  );

  // The subject is still connected and heartbeating, so any event that reaches
  // the watcher now would be a leak.
  const leak = await nextStatus(
    watcherSocket,
    subject.userId,
    (p) => p.isOnline === true,
    3000
  );
  check(
    "…and nothing leaks while the scope is NO_ONE",
    leak === null,
    leak ? JSON.stringify(leak) : "silent"
  );

  // --- widening: NO_ONE → EVERYONE, with NO re-subscribe -------------------
  const onlinePush = nextStatus(
    watcherSocket,
    subject.userId,
    (p) => p.isOnline === true
  );
  await setPrivacy(subject, { whoCanSeeOnlineStatus: "EVERYONE" });
  const on = await onlinePush;
  check(
    "NO_ONE → EVERYONE re-grants and pushes online, without re-subscribing",
    on !== null,
    on ? JSON.stringify(on) : "no online event within 8s"
  );

  // --- the re-granted subscription is live, not one-shot -------------------
  const disconnectPush = nextStatus(
    watcherSocket,
    subject.userId,
    (p) => p.isOnline === false,
    12000
  );
  clearInterval(beat);
  subjectSocket.disconnect();
  const gone = await disconnectPush;
  check(
    "the re-granted watcher still receives later presence changes",
    gone !== null,
    gone ? JSON.stringify(gone) : "no offline event within 12s"
  );

  // --- multi-device: the OWNER's other sessions ----------------------------
  // Same user, second socket = the "logged in on web AND phone" case. The
  // change is made over REST from a third context, so the push has to carry the
  // whole new state, not just echo it to the caller.
  const secondDevice = await connect(subject.token);
  if (!secondDevice) {
    check("second device for the subject connected", false, "handshake failed");
  } else {
    const synced = new Promise<Json | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      secondDevice.on("settings:updated", (p: Json) => {
        clearTimeout(timer);
        resolve(p);
      });
    });
    await setPrivacy(subject, { whoCanFindMe: "NO_ONE" });
    const pushed = await synced;
    check(
      "a privacy change pushes settings:updated to the owner's OTHER device",
      pushed?.privacy?.whoCanFindMe === "NO_ONE",
      pushed ? JSON.stringify(pushed.privacy) : "no event within 8s"
    );
    // A peer watching this user's presence must NOT receive their settings.
    const leaked = await nextStatus(
      watcherSocket,
      subject.userId,
      () => true,
      1500
    );
    check(
      "…and that push does not reach a presence watcher",
      leaked === null || !("privacy" in leaked),
      leaked ? JSON.stringify(leaked).slice(0, 120) : "silent"
    );
    secondDevice.disconnect();
  }

  watcherSocket.disconnect();
  report();
  console.log(`probe accounts: ${subject.account}, ${watcher.account}`);
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
