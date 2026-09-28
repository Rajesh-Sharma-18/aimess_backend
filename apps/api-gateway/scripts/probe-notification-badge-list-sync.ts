/**
 * Live probe: does the notification badge always equal what the list shows?
 *
 * The reported bug: a badge of 1 over an inbox with nothing unread in it. The
 * row behind it is a "Login Detected" alert, which the session that login
 * created is never shown — so the account-wide unread count over-counts THAT
 * session by one, and every mutation that answered with (or broadcast) the
 * account-wide number handed that device a badge its own list could not
 * explain.
 *
 * The invariant checked after every step, for every session independently:
 *
 *     GET /unread-count  ==  unread rows the session's own list returns
 *                        ==  the last count-bearing /notify frame it received
 *
 * Drives the running stack end to end:
 *
 *   register + login A, B          -> B's own alert is hidden from B
 *   connect /notify for A and B    -> connect counts
 *   login C with both sockets open -> live count frames on A and B
 *   C connects                     -> its own alert must not badge it
 *   A: POST /read-all              -> response count, both devices' frames
 *   A: PATCH .../action on C's row -> "It's Me" must MOVE the badge live
 *   A: DELETE a row                -> count follows the removal
 *   B: reconnect                   -> connect count must not drift
 *
 * Usage (from apps/api-gateway):
 *   pnpm exec tsx scripts/probe-notification-badge-list-sync.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { io, type Socket } from "socket.io-client";

const API = process.env.GATEWAY_API ?? "http://127.0.0.1:3000/api/v1";
const WS = process.env.GATEWAY_WS ?? "http://127.0.0.1:3000";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`
  );
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** Hashcash solver for POST /auth/challenge - the signup gate. */
function solve(challenge: string, bits: number): string {
  for (let n = 0; ; n++) {
    const solution = String(n);
    const d = createHash("sha256").update(`${challenge}.${solution}`).digest();
    let lead = 0;
    for (const byte of d) {
      if (byte === 0) {
        lead += 8;
        continue;
      }
      lead += Math.clz32(byte) - 24;
      break;
    }
    if (lead >= bits) return solution;
  }
}

const device = (id: string, name: string) => ({
  deviceId: id,
  platform: "WEB" as const,
  deviceType: "DESKTOP" as const,
  deviceName: name,
  browserName: "Chrome",
  osName: "Windows",
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface Sess {
  label: string;
  token: string;
  sessionId: string;
  userId: string;
}

function claims(token: string): {
  sid?: string;
  sub?: string;
  userId?: string;
} {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8")
  );
}

/**
 * `POST /auth/login` is IP-throttled and the dev gateway's bucket is shared
 * with the website dev server, so a re-runnable probe waits the window out
 * rather than failing on someone else's traffic.
 */
async function login(
  account: string,
  password: string,
  label: string
): Promise<Sess> {
  const attempt = () =>
    call("POST", "/auth/login", {
      account,
      password,
      device: device(
        `probe-${label}-${randomBytes(4).toString("hex")}`,
        `Probe ${label}`
      ),
    });
  let r = await attempt();
  for (let i = 0; r.status === 429 && i < 4; i++) {
    const wait = (Number(r.json?.error?.retryAfter) || 30) + 3;
    console.log(`  login ${label} rate-limited; waiting ${wait}s`);
    await sleep(wait * 1000);
    r = await attempt();
  }
  if (r.status !== 200)
    throw new Error(`login ${label} -> ${r.status} ${JSON.stringify(r.json)}`);
  const d = r.json.data ?? r.json;
  const token = d.tokens?.accessToken ?? d.accessToken;
  const c = claims(token);
  return {
    label,
    token,
    sessionId: c.sid ?? "",
    userId: c.sub ?? c.userId ?? "",
  };
}

async function unreadCount(s: Sess): Promise<number> {
  const r = await call(
    "GET",
    "/chat/notifications/unread-count",
    undefined,
    s.token
  );
  const d = r.json?.data ?? {};
  return d.unreadCount ?? d.count ?? -1;
}

async function rows(s: Sess): Promise<any[]> {
  const r = await call(
    "GET",
    "/chat/notifications?limit=50",
    undefined,
    s.token
  );
  const list = r.json?.data?.data ?? [];
  return Array.isArray(list) ? list : [];
}

const unreadRows = (list: any[]): any[] =>
  list.filter((n) => !n.isRead && !n.isDeleted);

interface Frame {
  event: string;
  at: number;
  data: any;
}

interface Device {
  sess: Sess;
  socket: Socket;
  frames: Frame[];
}

const COUNT_BEARING = new Set([
  "notification:count",
  "notification:count_update",
  "notification:new",
  "notification:read",
  "notification:all-read",
  "notification:deleted",
]);

/** The number the badge is holding: the last count any frame carried. */
function lastFrameCount(d: Device): number | undefined {
  for (let i = d.frames.length - 1; i >= 0; i--) {
    const f = d.frames[i];
    if (!COUNT_BEARING.has(f.event)) continue;
    const v = f.data?.unreadCount ?? f.data?.count;
    if (typeof v === "number") return v;
  }
  return undefined;
}

async function connectNotify(s: Sess): Promise<Device> {
  const frames: Frame[] = [];
  const socket = io(`${WS}/notify`, {
    transports: ["websocket"],
    auth: { token: s.token },
    extraHeaders: { Authorization: `Bearer ${s.token}` },
  });
  socket.onAny((event: string, ...args: unknown[]) => {
    frames.push({ event, at: Date.now(), data: args[0] });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (e: Error) => reject(e));
    setTimeout(
      () => reject(new Error(`/notify connect timeout ${s.label}`)),
      15000
    );
  });
  // The connect frame (`notification:count`) arrives just after the handshake.
  await sleep(1200);
  return { sess: s, socket, frames };
}

/**
 * The one rule this probe exists for. Reported per session, never per account.
 */
async function assertInSync(d: Device, when: string): Promise<void> {
  const [count, list] = await Promise.all([unreadCount(d.sess), rows(d.sess)]);
  const visible = unreadRows(list).length;
  const badge = lastFrameCount(d);
  check(
    `[${d.sess.label}] ${when}: /unread-count == unread rows in its own list`,
    count === visible,
    `unread-count=${count} listUnread=${visible}`
  );
  check(
    `[${d.sess.label}] ${when}: last socket frame agrees with /unread-count`,
    badge === undefined || badge === count,
    `badge=${badge} unread-count=${count}`
  );
}

/** Wait until this session can see a login alert raised for `trigger`. */
async function waitForLoginRow(
  viewer: Sess,
  trigger: Sess,
  timeoutMs = 25000
): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await rows(viewer)).find(
      (n) =>
        n.type === "auth.security_new_login" &&
        (n.payload?.data?.sessionId ?? n.data?.sessionId) === trigger.sessionId
    );
    if (found) return found;
    await sleep(1500);
  }
  return null;
}

async function main(): Promise<void> {
  const account = `probe${randomBytes(5).toString("hex")}`;
  const password = `Pw!${randomBytes(6).toString("hex")}A9`;

  const ch = await call("POST", "/auth/challenge");
  const chData = ch.json.data ?? ch.json;
  const reg = await call("POST", "/auth/register", {
    account,
    password,
    proof: {
      challenge: chData.challenge,
      solution: solve(chData.challenge, chData.difficultyBits),
    },
    device: device(`probe-reg-${randomBytes(4).toString("hex")}`, "Probe REG"),
  });
  if (reg.status !== 201 && reg.status !== 200)
    throw new Error(`register -> ${reg.status} ${JSON.stringify(reg.json)}`);
  console.log(`account=${account}\n`);

  const A = await login(account, password, "A");
  await sleep(1500);
  const B = await login(account, password, "B");
  console.log(`A.session=${A.sessionId}\nB.session=${B.sessionId}\n`);

  // The alert travels auth -> broker -> notifications-service -> chat-service.
  const bAlertSeenByA = await waitForLoginRow(A, B);
  if (!bAlertSeenByA) {
    console.log(
      "SKIP  no Login Detected row ever reached A - the broker never " +
        "delivered B's login event to this stack, so the regression this " +
        "probe reproduces cannot be staged. Nothing below would be meaningful."
    );
    process.exit(2);
  }
  console.log(`B's alert is visible to A as ${bAlertSeenByA.id}\n`);

  const devA = await connectNotify(A);
  const devB = await connectNotify(B);

  // ---- the screenshot -----------------------------------------------------
  const bCount = await unreadCount(B);
  const bVisible = unreadRows(await rows(B)).length;
  check(
    "B's badge does not count the login alert B's own list withholds",
    bCount === bVisible,
    `unread-count=${bCount} listUnread=${bVisible}`
  );
  check(
    "B's connect frame agrees with B's /unread-count",
    lastFrameCount(devB) === bCount,
    `connectFrame=${lastFrameCount(devB)} unread-count=${bCount}`
  );
  await assertInSync(devA, "after connect");

  // ---- the exact call the web inbox makes when you open it ----------------
  // The client marks read with a WATERMARK: only rows at or before the newest
  // one it could see. B's own login alert is newer than that and invisible to
  // B, so it survives unread — and this response is what B's badge is set
  // from. Answering it with the account-wide count is the screenshot: badge 1
  // over an inbox with nothing unread in it.
  const bVisibleRows = unreadRows(await rows(B));
  if (bVisibleRows.length > 0) {
    const watermark = Math.max(
      ...bVisibleRows.map((r) => Number(r.createdAt) || 0)
    );
    const bReadAll = await call(
      "POST",
      "/chat/notifications/read-all",
      { before: watermark },
      B.token
    );
    await sleep(1500);
    const bVisibleAfter = unreadRows(await rows(B)).length;
    check(
      "B's watermarked read-all answers with B's own count, not the account's",
      bReadAll.json?.data?.unreadCount === bVisibleAfter,
      `response=${bReadAll.json?.data?.unreadCount} listUnread=${bVisibleAfter}`
    );
    await assertInSync(devB, "after the inbox marked what it could see read");
    await assertInSync(devA, "after B's watermarked read-all");
  }

  // ---- a third login, live on both open sockets ---------------------------
  const aBefore = await unreadCount(A);
  const bBefore = await unreadCount(B);
  const C = await login(account, password, "C");
  console.log(`\nC.session=${C.sessionId}`);
  const cAlertSeenByA = await waitForLoginRow(A, C);
  check("C's login raised an alert A can see", !!cAlertSeenByA);
  await sleep(2500);

  const aAfter = await unreadCount(A);
  const bAfter = await unreadCount(B);
  check(
    "A's badge went up by exactly one, live",
    aAfter === aBefore + 1 && lastFrameCount(devA) === aAfter,
    `before=${aBefore} after=${aAfter} frame=${lastFrameCount(devA)}`
  );
  check(
    "B's badge went up by exactly one, live",
    bAfter === bBefore + 1 && lastFrameCount(devB) === bAfter,
    `before=${bBefore} after=${bAfter} frame=${lastFrameCount(devB)}`
  );

  const devC = await connectNotify(C);
  const cCount = await unreadCount(C);
  const cVisible = unreadRows(await rows(C)).length;
  check(
    "C is not badged for its own login alert",
    cCount === cVisible && lastFrameCount(devC) === cCount,
    `unread-count=${cCount} listUnread=${cVisible} frame=${lastFrameCount(devC)}`
  );
  check(
    "one row, three sessions, three different correct badges",
    aAfter !== cCount || bAfter !== cCount ? true : aAfter === cCount,
    `A=${aAfter} B=${bAfter} C=${cCount}`
  );

  // ---- mark all read ------------------------------------------------------
  const readAll = await call(
    "POST",
    "/chat/notifications/read-all",
    {},
    A.token
  );
  await sleep(1500);
  check(
    "A's read-all response is A's own count, and it is zero",
    readAll.json?.data?.unreadCount === 0,
    `response=${JSON.stringify(readAll.json?.data?.unreadCount)}`
  );
  await assertInSync(devA, "after read-all");
  await assertInSync(devB, "after read-all");
  await assertInSync(devC, "after read-all");
  check(
    "the badge disappeared on every device without a reload",
    lastFrameCount(devA) === 0 &&
      lastFrameCount(devB) === 0 &&
      lastFrameCount(devC) === 0,
    `A=${lastFrameCount(devA)} B=${lastFrameCount(devB)} C=${lastFrameCount(devC)}`
  );

  // ---- "It's Me" must move the badge, live --------------------------------
  const D = await login(account, password, "D");
  const dAlert = await waitForLoginRow(A, D);
  check("D's login raised an alert A can see", !!dAlert);
  await sleep(2000);
  const beforeAction = {
    A: lastFrameCount(devA),
    B: lastFrameCount(devB),
    C: lastFrameCount(devC),
  };
  const framesBefore = devB.frames.length;
  const action = await call(
    "PATCH",
    `/chat/notifications/${dAlert.id}/action`,
    { action: "CONFIRM", body: "This was you." },
    A.token
  );
  check(
    "A may answer D's alert",
    action.status === 200,
    `status=${action.status}`
  );
  await sleep(2000);
  check(
    "acting on the card moved the badge with no refetch",
    lastFrameCount(devB) !== beforeAction.B &&
      devB.frames.length > framesBefore,
    `before=${beforeAction.B} after=${lastFrameCount(devB)}`
  );
  await assertInSync(devA, "after It's Me");
  await assertInSync(devB, "after It's Me");

  // ---- delete ------------------------------------------------------------
  const toDelete = (await rows(A))[0];
  if (toDelete) {
    const del = await call(
      "DELETE",
      `/chat/notifications/${toDelete.id}`,
      undefined,
      A.token
    );
    check("delete succeeded", del.status === 200, `status=${del.status}`);
    await sleep(1500);
    check(
      "the delete response carries A's own count",
      del.json?.data?.unreadCount === (await unreadCount(A)),
      `response=${del.json?.data?.unreadCount}`
    );
    await assertInSync(devA, "after delete");
    await assertInSync(devB, "after delete");
  }

  // ---- reconnect must not drift ------------------------------------------
  devB.socket.disconnect();
  await sleep(1000);
  const devB2 = await connectNotify(B);
  await assertInSync(devB2, "after reconnect");
  const bRest = await unreadCount(B);
  check(
    "reconnecting B re-reads the same count, not a drifted one",
    lastFrameCount(devB2) === bRest,
    `frame=${lastFrameCount(devB2)} unread-count=${bRest}`
  );

  for (const d of [devA, devB2, devC]) d.socket.disconnect();

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
