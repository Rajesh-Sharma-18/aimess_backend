/**
 * Live end-to-end check for "Automatically Delete Messages" (private chats).
 *
 * Exercises the real stack — api-gateway -> chat-service -> Mongo — because the
 * Jest suite mocks the repositories and therefore cannot see how Prisma actually
 * translates a filter against MongoDB. The bug that shipped and deleted real
 * messages (`{lte: now}` also matching an explicit `autoDeleteAt: null`) was
 * invisible to every mocked test and only showed up here.
 *
 * Usage:
 *   ROOM=prv_xxx USER_A=<uuid> USER_B=<uuid> \
 *   JWT_ACCESS_SECRET=<dev secret> \
 *   pnpm --filter @aimess/chat-service exec tsx scripts/e2e-auto-delete.ts
 *
 * Standalone — does NOT load the chat-service env schema. Tokens are minted with
 * the shared signer and the dev access secret; chat-service treats an unknown
 * sessionId as active, so no auth-service round-trip is needed.
 *
 * Read `preflight()` before adding assertions: it pins the three assumptions
 * that previously made this harness lie about its own results.
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";

const GW = process.env.GATEWAY_URL ?? "http://localhost:3000/api/v1";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const ROOM = process.env.ROOM ?? "";
const A = process.env.USER_A ?? "";
const B = process.env.USER_B ?? "";

if (!SECRET || !ROOM || !A || !B) {
  console.error("ROOM, USER_A, USER_B and JWT_ACCESS_SECRET are all required.");
  process.exit(2);
}

const mint = (userId: string): string =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 3600,
  });
const TA = mint(A);
const TB = mint(B);

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** Abort the whole run — a broken precondition makes every later result noise. */
function fatal(message: string): never {
  console.error(`\nPRECONDITION FAILED: ${message}\n`);
  process.exit(2);
}

interface ApiResult {
  status: number;
  body: { data?: Record<string, unknown>; message?: string } | null;
}

/**
 * Every call asserts its status. The previous version of this script returned
 * the status and let callers ignore it, so a mark-read that 400'd on a wrong
 * field name looked exactly like a passing no-op — and turned a broken
 * assertion into a green one. `expect: null` opts out for the cases that are
 * deliberately probing a rejection.
 */
async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  expect: number | null = 200
): Promise<ApiResult> {
  const res = await fetch(`${GW}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json: ApiResult["body"] = null;
  try {
    json = (await res.json()) as ApiResult["body"];
  } catch {
    /* empty body is fine */
  }
  if (expect !== null && res.status !== expect) {
    fatal(
      `${method} ${path} expected ${expect}, got ${res.status}: ${JSON.stringify(json)}`
    );
  }
  return { status: res.status, body: json };
}

const getAD = (t: string) =>
  api(t, "GET", `/chat/private/rooms/${ROOM}/auto-delete`);
const setAD = (t: string, payload: unknown, expect: number | null = 200) =>
  api(t, "PUT", `/chat/private/rooms/${ROOM}/auto-delete`, payload, expect);
const send = (t: string, receiverId: string, text: string) =>
  api(
    t,
    "POST",
    `/chat/private/rooms/${ROOM}/messages`,
    {
      receiverId,
      content: { text, urls: [], files: [] },
      messageType: "TEXT",
      clientMessageId: randomUUID(),
    },
    null // send returns 200 or 201 depending on path
  );
const history = (t: string) =>
  api(t, "GET", `/chat/private/rooms/${ROOM}/messages?limit=30`);
/** NOTE: the field is `upToMessageId`. `lastMessageId` silently 400s. */
const markRead = (t: string, messageId: string) =>
  api(t, "POST", `/chat/private/rooms/${ROOM}/read`, {
    upToMessageId: messageId,
  });

const sleep = (millis: number) => new Promise((r) => setTimeout(r, millis));

type Wire = Record<string, unknown>;
const rows = (r: ApiResult): Wire[] =>
  ((r.body?.data as { data?: Wire[] } | undefined)?.data ?? []) as Wire[];
const findMsg = (list: Wire[], id: string): Wire | undefined =>
  list.find((m) => (m.id ?? m.messageId) === id);
const sentId = (r: ApiResult): string =>
  String((r.body?.data as Wire)?.messageId ?? (r.body?.data as Wire)?.id ?? "");

/** This API serializes Dates to epoch ms — `Date.parse` on them yields NaN. */
const ms = (v: unknown): number =>
  typeof v === "number" ? v : Date.parse(String(v));
/** Deadline minus send time, in ms. NaN here means the shape changed — see preflight. */
const ttlOf = (m: Wire | undefined): number =>
  ms(m?.autoDeleteAt) - ms(m?.createdAt ?? m?.serverTs);

/**
 * The three assumptions that previously let this harness report green while
 * measuring nothing. Each is checked once, up front, and aborts the run.
 */
async function preflight(): Promise<void> {
  // 1. Both users really are participants of this room.
  for (const [label, token] of [
    ["USER_A", TA],
    ["USER_B", TB],
  ] as const) {
    const room = await api(
      token,
      "GET",
      `/chat/private/rooms/${ROOM}`,
      undefined,
      null
    );
    if (room.status !== 200) {
      fatal(
        `${label} cannot read ${ROOM} (status ${room.status}) — not a participant?`
      );
    }
  }

  // 2. Timestamps are epoch-ms numbers, not ISO strings. If this ever flips,
  //    every duration assertion below silently becomes NaN-vs-NaN.
  const probe = await send(TA, B, `preflight ${Date.now()}`);
  await sleep(400);
  const m = findMsg(rows(await history(TA)), sentId(probe));
  if (!m) fatal("preflight message did not appear in history");
  if (typeof m.createdAt !== "number") {
    fatal(
      `expected createdAt to be epoch ms, got ${typeof m.createdAt} (${String(m.createdAt)}) — update ms()`
    );
  }

  // 3. Neither participant has a live client. A real client auto-reads incoming
  //    messages within ~0.5s, which ARMS "After Viewing" behind the harness's
  //    back and makes correct behaviour look like a failure.
  for (const [label, token, other] of [
    ["USER_A", TB, A],
    ["USER_B", TA, B],
  ] as const) {
    const p = await api(
      token,
      "GET",
      `/chat/private/presence/${other}`,
      undefined,
      null
    );
    if (
      p.status === 200 &&
      (p.body?.data as Wire | undefined)?.isOnline === true
    ) {
      fatal(
        `${label} (${other}) has a LIVE client connected. It will read messages ` +
          `automatically and arm After-Viewing timers. Pick a room whose ` +
          `participants are both offline and re-run.`
      );
    }
  }
}

console.log(`room=${ROOM}\nA=${A}\nB=${B}\n`);
await preflight();
console.log(
  "preflight OK — participants verified, timestamps epoch-ms, both peers offline\n"
);

// Known starting point.
await setAD(TA, { mode: "OFF" });
await setAD(TB, { mode: "OFF" });

console.log("1. Baseline — feature off");
{
  const r = await getAD(TA);
  check("mode OFF", (r.body?.data as Wire)?.mode === "OFF");
  check("isEnabled false", (r.body?.data as Wire)?.isEnabled === false);
}

console.log("\n2. Validation");
{
  await setAD(TA, { mode: "TIMER", ttlSeconds: 5 }, 400);
  check("ttl below the floor is rejected", true);
  await setAD(TA, { mode: "SOMETIMES" }, 400);
  check("unknown mode is rejected", true);
  await api(
    TA,
    "GET",
    `/chat/private/rooms/prv_does_not_exist/auto-delete`,
    undefined,
    404
  );
  check("unknown room is 404", true);
}

console.log("\n3. A enables a 1-hour timer (one-sided)");
{
  const r = await setAD(TA, { mode: "TIMER", ttlSeconds: 3600 });
  const d = r.body?.data as Wire;
  check("effective mode TIMER", d?.mode === "TIMER");
  check("ttlSeconds 3600", d?.ttlSeconds === 3600);
  check("label '1 hour'", d?.label === "1 hour", String(d?.label));
  check("peer side still OFF", (d?.peer as Wire)?.mode === "OFF");

  const bView = (await getAD(TB)).body?.data as Wire;
  check(
    "B's next message follows A's timer (one-sided)",
    bView?.mode === "TIMER" && bView?.ttlSeconds === 3600
  );
  check("B's own side is OFF", (bView?.self as Wire)?.mode === "OFF");

  await sleep(600);
  const sys = rows(await history(TB)).find(
    (m) => m.systemEvent === "AUTO_DELETE_UPDATED"
  );
  check("system message posted in chat", Boolean(sys));
  check(
    "system text names the timer",
    String((sys?.content as Wire)?.text ?? "").includes("1 hour"),
    String((sys?.content as Wire)?.text)
  );
}

console.log("\n4. New messages carry the deadline");
let aMsgId: string;
let bMsgId: string;
{
  aMsgId = sentId(await send(TA, B, "probe from A"));
  bMsgId = sentId(await send(TB, A, "probe from B"));
  await sleep(400);
  const list = rows(await history(TA));
  const a = findMsg(list, aMsgId);
  const b = findMsg(list, bMsgId);
  check("A's message has a deadline", Boolean(a?.autoDeleteAt));
  check(
    "deadline is sentAt + 1h",
    Math.abs(ttlOf(a) - 3600_000) < 5000,
    `${ttlOf(a)}ms`
  );
  check(
    "one-sided: B's message follows A's timer",
    Math.abs(ttlOf(b) - 3600_000) < 5000,
    `${ttlOf(b)}ms`
  );
}

console.log("\n5. Both sides configured — per-sender timers");
{
  await setAD(TB, { mode: "TIMER", ttlSeconds: 86400 });
  const a = sentId(await send(TA, B, "A with both configured"));
  const b = sentId(await send(TB, A, "B with both configured"));
  await sleep(400);
  const list = rows(await history(TA));
  check(
    "A's message uses A's 1h",
    Math.abs(ttlOf(findMsg(list, a)) - 3600_000) < 5000
  );
  check(
    "B's message uses B's 24h",
    Math.abs(ttlOf(findMsg(list, b)) - 86400_000) < 5000
  );
}

console.log("\n6. Changing the timer re-stamps pending messages (§8.8)");
{
  const r = await setAD(TA, { mode: "TIMER", ttlSeconds: 604800 });
  check("label '1 week'", (r.body?.data as Wire)?.label === "1 week");
  await sleep(600);
  const list = rows(await history(TA));
  check(
    "A's pending message re-stamped to createdAt + 1w",
    Math.abs(ttlOf(findMsg(list, aMsgId)) - 604800_000) < 5000,
    `${ttlOf(findMsg(list, aMsgId))}ms`
  );
  check(
    "B's message keeps B's own 24h (A's change didn't touch it)",
    Math.abs(ttlOf(findMsg(list, bMsgId)) - 86400_000) < 5000
  );
}

console.log("\n7. Turning it OFF (§7)");
{
  await setAD(TA, { mode: "OFF" });
  const m1 = sentId(await send(TA, B, "after A turned it off"));
  await sleep(400);
  let list = rows(await history(TA));
  check(
    "A's new message follows B's still-active timer",
    Math.abs(ttlOf(findMsg(list, m1)) - 86400_000) < 5000
  );
  check(
    "already-armed message keeps its deadline",
    Boolean(findMsg(list, aMsgId)?.autoDeleteAt)
  );

  await setAD(TB, { mode: "OFF" });
  const m2 = sentId(await send(TA, B, "both off"));
  await sleep(400);
  list = rows(await history(TA));
  check(
    "both OFF -> no deadline on new messages",
    !findMsg(list, m2)?.autoDeleteAt
  );
}

console.log("\n8. After Viewing arms on the recipient's read receipt (§3.4)");
let avMsgId: string;
{
  await setAD(TA, { mode: "AFTER_VIEWING" });
  const r = (await getAD(TA)).body?.data as Wire;
  check("mode AFTER_VIEWING", r?.mode === "AFTER_VIEWING");
  check("no ttl for after-viewing", r?.ttlSeconds === null);

  avMsgId = sentId(await send(TA, B, "burn after reading"));
  await sleep(400);
  check(
    "no deadline before the recipient reads",
    !findMsg(rows(await history(TA)), avMsgId)?.autoDeleteAt
  );

  await markRead(TA, avMsgId);
  await sleep(500);
  check(
    "the sender's own read does NOT arm it",
    !findMsg(rows(await history(TA)), avMsgId)?.autoDeleteAt
  );

  await markRead(TB, avMsgId);
  await sleep(700);
  const armed = findMsg(rows(await history(TA)), avMsgId);
  check("the recipient's read arms it", Boolean(armed?.autoDeleteAt));
  const grace = ms(armed?.autoDeleteAt) - Date.now();
  check(
    "grace period is short (<15s)",
    grace > -2000 && grace < 15000,
    `${grace}ms`
  );
}

console.log("\n9. The sweeper deletes ONLY what is due");
{
  // Controls sent while the feature is off / unread — these must SURVIVE. This
  // is the case the shipped null-matching bug destroyed, so it is asserted
  // explicitly rather than inferred from the absence of complaints.
  await setAD(TA, { mode: "OFF" });
  const plainId = sentId(await send(TA, B, "no timer — must survive"));
  await setAD(TA, { mode: "AFTER_VIEWING" });
  const unreadId = sentId(
    await send(TA, B, "unread after-viewing — must survive")
  );
  await setAD(TA, { mode: "OFF" });

  check(
    "armed message still present before the sweep window",
    Boolean(findMsg(rows(await history(TA)), avMsgId)?.autoDeleteAt)
  );

  let swept = false;
  for (let i = 0; i < 15 && !swept; i++) {
    await sleep(3000);
    const list = rows(await history(TA));
    const m = findMsg(list, avMsgId);
    swept = !m || m.isDeleted === true;
  }
  check("armed after-viewing message is swept", swept);

  const list = rows(await history(TA));
  check(
    "a message with NO timer survives the sweep",
    Boolean(findMsg(list, plainId))
  );
  check(
    "an UNREAD after-viewing message survives the sweep",
    Boolean(findMsg(list, unreadId))
  );
}

console.log("\n10. Cleanup");
{
  await setAD(TA, { mode: "OFF" });
  await setAD(TB, { mode: "OFF" });
  check(
    "both sides OFF again",
    (await getAD(TA)).body?.data?.isEnabled === false
  );
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
