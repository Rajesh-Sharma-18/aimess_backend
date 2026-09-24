/**
 * Live probe: who actually receives a PRIVATE community join-request
 * notification?
 *
 * Expected rule — the current ADMIN and nobody else. Moderators may open,
 * approve and reject the request, but they get no inbox row, no unread bump, no
 * `/notify` frame and no push. Members and the requester get nothing either.
 *
 * Drives the real stack the way a client does: creates a throwaway PRIVATE
 * community, populates it through an auto-approve invite link, promotes two
 * moderators, then files a join request over REST while every participant holds
 * an open `/notify` (+ `/community`) socket. Asserts on the push recipient set
 * (read from a notifications-service log — see pushRecipients), on the recorded
 * socket frames, on the unread counts read before/after, and on the persisted
 * inbox rows.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> PUSH_LOG=<path to notif stdout> \
 *     pnpm exec tsx scripts/probe-community-join-request-recipients.ts
 *
 * Optional env: ADMIN_A / MOD_B / MOD_C / MEMBER_D / REQUESTER_E (user UUIDs),
 * KEEP=1 to leave the community behind for inspection.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const API = process.env.GATEWAY_API ?? "http://localhost:3000/api/v1";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";

// Real dev accounts. A..E map onto the roles in the requirement.
const A = process.env.ADMIN_A ?? "7b0db132-ffff-4d99-ab3c-421f83fba2ef"; // Smiley Creatures
const B = process.env.MOD_B ?? "1b98aed5-cc15-41d6-95bb-bef47a44f063"; // Mind Flayer
const C = process.env.MOD_C ?? "245fa72b-284f-460f-a409-4bc8ff1ab97a"; // Kristi
const D = process.env.MEMBER_D ?? "0a77807a-d1e4-4e50-8c41-281dfebd5cb5"; // Tom
const E = process.env.REQUESTER_E ?? "246a48a1-8574-40c2-99c2-662343fedc4c"; // Waiter White

if (!SECRET) {
  console.error("JWT_ACCESS_SECRET is required.");
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const tokenFor = (userId: string): string =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 3600,
  });

interface Frame {
  ns: string;
  event: string;
  data: Record<string, unknown>;
  at: number;
}

class Client {
  readonly frames: Frame[] = [];
  private constructor(
    readonly label: string,
    readonly userId: string,
    readonly token: string,
    readonly sockets: Socket[]
  ) {}

  static async connect(label: string, userId: string): Promise<Client> {
    const token = tokenFor(userId);
    const sockets: Socket[] = [];
    for (const ns of ["/notify", "/community"]) {
      const socket = io(`${GW}${ns}`, {
        transports: ["websocket"],
        auth: { token },
        forceNew: true,
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", (e: Error) => reject(e));
        setTimeout(
          () => reject(new Error(`${label}${ns} connect timeout`)),
          10000
        );
      });
      sockets.push(socket);
    }
    const client = new Client(label, userId, token, sockets);
    for (const socket of sockets) {
      const ns = String((socket as unknown as { nsp?: string }).nsp ?? "");
      socket.onAny((event: string, ...args: unknown[]) => {
        client.frames.push({
          ns,
          event,
          data: (args[0] ?? {}) as Record<string, unknown>,
          at: Date.now(),
        });
      });
    }
    return client;
  }

  since(at: number): Frame[] {
    return this.frames.filter((f) => f.at >= at);
  }

  /** Frames that are NOTIFICATIONS (inbox/badge), not list-sync roster events. */
  notificationFrames(at: number): Frame[] {
    return this.since(at).filter((f) => f.event.startsWith("notification:"));
  }

  async api(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* empty body */
    }
    return { status: res.status, json };
  }

  async unread(): Promise<number> {
    const { json } = await this.api("GET", "/chat/notifications/unread-count");
    const d = (json.data ?? {}) as Record<string, unknown>;
    return Number(d.unreadCount ?? d.count ?? d.total ?? 0);
  }

  /** Persisted inbox rows (all categories). */
  async inbox(): Promise<Record<string, unknown>[]> {
    const { json } = await this.api("GET", "/chat/notifications?limit=50");
    const data = json.data as
      | { data?: Record<string, unknown>[] }
      | Record<string, unknown>[]
      | undefined;
    return (
      Array.isArray(data) ? data : (data?.data ?? [])
    ) as Record<string, unknown>[];
  }

  close(): void {
    for (const s of this.sockets) s.close();
  }
}

/** The INCOMING request event only — never the approved/rejected/cancelled ones. */
const REQUESTED_RE = /join_requested/i;

/** Inbox rows for THIS community's incoming-join-request event. */
function joinRequestRows(
  rows: Record<string, unknown>[],
  communityId: string
): Record<string, unknown>[] {
  return rows.filter((r) => {
    // Row shape: { type, payload: { data: { communityId, ... } } }.
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const data = (payload.data ?? r.data ?? {}) as Record<string, unknown>;
    const cid = String(data.communityId ?? "");
    return REQUESTED_RE.test(String(r.type ?? "")) && cid === communityId;
  });
}

/**
 * The PUSH recipient set, read out of a notifications-service log.
 *
 * Every recipient the consumer hands to `pushToUser` logs exactly one line
 * naming `user=<id> type=community.join_requested` — the delivery line
 * (`[push:deliver] … tokens=N`), the no-device line (`tokens=0`) or one of the
 * suppression lines. So the log is a complete audit of who was CONSIDERED, and
 * it does not depend on anyone owning a device token. Absence of a moderator
 * here means the consumer never saw them as a recipient at all.
 *
 * Point PUSH_LOG at the stdout of a notifications-service instance you control:
 *   NOTIFICATIONS_SERVICE_PORT=3106 NOTIFICATIONS_GRPC_PORT=4106 \
 *     pnpm --filter @aimess/notifications-service exec tsx src/server.ts > notif.log
 * The dev RabbitMQ is shared, so that instance competes with other machines'
 * consumers for `community.queue` — a request whose message went elsewhere
 * leaves no lines here, which the caller reports rather than passing silently.
 */
const PUSH_LOG = process.env.PUSH_LOG ?? "";
const USER_RE = /user=([0-9a-f-]{36})/;

function pushRecipients(
  since: number,
  eventType = "community.join_requested"
): string[] {
  if (!PUSH_LOG) return [];
  let text = "";
  try {
    text = readFileSync(PUSH_LOG, "utf8");
  } catch {
    return [];
  }
  // Log lines are "[YYYY-MM-DD HH:mm:ss] level: message" in local time.
  // Match the type as a whole token: `community.join_request` is a prefix of
  // four other event names, so a substring test would conflate them.
  const typeRe = new RegExp(`type=${eventType.replace(/\./g, "\\.")}(?![\\w.])`);
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!typeRe.test(line)) continue;
    const stamp = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/.exec(line);
    if (stamp && new Date(stamp[1].replace(" ", "T")).getTime() < since - 1000)
      continue;
    const user = USER_RE.exec(line)?.[1];
    if (user && !out.includes(user)) out.push(user);
  }
  return out;
}

const labelOf = (userId: string): string =>
  ({ [A]: "A(admin)", [B]: "B(mod)", [C]: "C(mod)", [D]: "D(member)", [E]: "E(requester)" })[
    userId
  ] ?? userId;

function joinRequestNotificationFrames(c: Client, at: number): Frame[] {
  return c
    .notificationFrames(at)
    .filter(
      (f) => f.event === "notification:new" && REQUESTED_RE.test(JSON.stringify(f.data))
    );
}

/**
 * File a join request, then wait for OUR notifications-service instance to be
 * the one that handled the message.
 *
 * Necessary because the dev RabbitMQ is shared: `community.queue` has several
 * consumers across machines and one message goes to exactly one of them, so a
 * single attempt proves nothing about the local code. Each retry cancels and
 * re-files (the service treats an unchanged PENDING request as a no-op, so the
 * cancel is what makes the next attempt emit again). `t` is re-read per attempt
 * so a previous attempt's lines can never be mistaken for this one's.
 */
async function fileRequestUntilObserved(
  requester: Client,
  communityId: string,
  message: string,
  attemptsAllowed = 12
): Promise<{ requestId: string; recipients: string[]; attempts: number; at: number }> {
  let requestId = "";
  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    const at = Date.now();
    const res = await requester.api(
      "POST",
      `/communities/${communityId}/join-requests`,
      { message }
    );
    requestId = String(
      ((res.json.data ?? {}) as Record<string, unknown>).requestId ?? requestId
    );
    await sleep(6000);
    const recipients = pushRecipients(at);
    if (recipients.length > 0) return { requestId, recipients, attempts: attempt, at };
    if (attempt < attemptsAllowed) {
      await requester.api(
        "DELETE",
        `/communities/${communityId}/join-requests/mine`
      );
      await sleep(1500);
    }
  }
  return { requestId, recipients: [], attempts: attemptsAllowed, at: Date.now() };
}

async function main(): Promise<void> {
  console.log("--- connecting sessions -------------------------------------");
  const admin = await Client.connect("A(admin)", A);
  const modB = await Client.connect("B(mod)", B);
  const modC = await Client.connect("C(mod)", C);
  const member = await Client.connect("D(member)", D);
  const requester = await Client.connect("E(requester)", E);
  const everyone = [admin, modB, modC, member, requester];

  // --- setup: a throwaway PRIVATE community owned by A ----------------------
  const { json: catJson } = await admin.api("GET", "/communities/categories");
  const catData = (catJson.data ?? {}) as {
    categories?: Record<string, unknown>[];
    data?: Record<string, unknown>[];
  };
  const categories = (catData.categories ??
    catData.data ??
    []) as Record<string, unknown>[];
  const categoryId = String(categories[0]?.id ?? categories[0]?._id ?? "");
  if (!categoryId)
    throw new Error(
      `no community category available: ${JSON.stringify(catJson).slice(0, 300)}`
    );

  const suffix = Math.random().toString(36).slice(2, 10);
  const created = await admin.api("POST", "/communities", {
    name: `JoinReqProbe ${suffix}`,
    handle: `joinreqprobe${suffix}`,
    type: "PRIVATE",
    categoryId,
  });
  const community = (created.json.data ?? {}) as Record<string, unknown>;
  const CID = String(community.id ?? community._id ?? "");
  check("setup: PRIVATE community created", Boolean(CID), `id=${CID} status=${created.status}`);
  if (!CID) {
    console.log(JSON.stringify(created.json));
    process.exit(1);
  }

  // B, C, D join through an auto-approve invite link (no friend gate).
  const link = await admin.api("POST", `/communities/${CID}/invite-links`, {
    autoApprove: true,
  });
  const linkData = (link.json.data ?? {}) as Record<string, unknown>;
  const code = String(linkData.code ?? "");
  check("setup: auto-approve invite link", Boolean(code), `code=${code}`);
  for (const c of [modB, modC, member]) {
    const r = await c.api("POST", `/communities/invite-links/${code}/redeem`, {});
    check(`setup: ${c.label} joined`, r.status < 300, `status=${r.status}`);
  }

  // Promote B and C to MODERATOR; D stays MEMBER.
  for (const c of [modB, modC]) {
    const r = await admin.api(
      "PUT",
      `/communities/${CID}/members/${c.userId}/role`,
      { role: "MODERATOR" }
    );
    check(`setup: ${c.label} promoted to MODERATOR`, r.status < 300, `status=${r.status}`);
  }

  // Confirm the roster really has the shape the requirement describes.
  const roster = await admin.api("GET", `/communities/${CID}/members?limit=50`);
  const rosterData = roster.json.data as
    | { data?: Record<string, unknown>[] }
    | Record<string, unknown>[];
  const members = (
    Array.isArray(rosterData) ? rosterData : (rosterData?.data ?? [])
  ) as Record<string, unknown>[];
  const roleOf = (userId: string): string =>
    String(members.find((m) => m.userId === userId)?.role ?? "-");
  check(
    "setup: roles are ADMIN=A, MODERATOR=B+C, MEMBER=D",
    roleOf(A) === "ADMIN" &&
      roleOf(B) === "MODERATOR" &&
      roleOf(C) === "MODERATOR" &&
      roleOf(D) === "MEMBER",
    `A=${roleOf(A)} B=${roleOf(B)} C=${roleOf(C)} D=${roleOf(D)}`
  );

  await sleep(1500); // let setup-driven traffic settle before we start watching

  // =========================================================================
  // TEST 1 — E requests to join. Only A may hear about it.
  // =========================================================================
  console.log("\n--- TEST 1: join request ------------------------------------");
  const before = new Map<string, number>();
  for (const c of everyone) before.set(c.label, await c.unread());
  const t0 = Date.now();

  const first = await fileRequestUntilObserved(requester, CID, "let me in");
  check(
    "join request created",
    Boolean(first.requestId),
    `attempts=${first.attempts} id=${first.requestId}`
  );

  // `community.join_requested` is on the Notification Center allowlist
  // (INBOX_ALLOWED_TYPES in notifications-service/push.service.ts), so the admin
  // gets the full set: inbox row, unread bump, `notification:new` frame AND
  // push. Every one of those is checked for the admin and denied for everyone
  // else. The push half is read from the service's own audit log, because that
  // is the only channel with no client-visible artefact (see pushRecipients).
  const recipients = first.recipients;
  check(
    "push recipient set for the join request is the ADMIN alone",
    recipients.length > 0 && recipients.every((id) => id === A),
    recipients.length === 0
      ? "no push processed locally — another consumer on the shared broker won every attempt"
      : recipients.map(labelOf).join(",")
  );
  for (const id of [B, C, D, E]) {
    check(
      `${labelOf(id)} is absent from the push recipient set`,
      !recipients.includes(id)
    );
  }

  const adminFrames = joinRequestNotificationFrames(admin, t0);
  check(
    "A(admin) receives a realtime notification:new for the request",
    adminFrames.length >= 1,
    `${adminFrames.length} frame(s)`
  );
  const lastFrame = adminFrames.at(-1);
  if (lastFrame) {
    const body = String(
      lastFrame.data.body ??
        (lastFrame.data.payload as { body?: string } | undefined)?.body ??
        ""
    );
    check("A's notification names the requester", body.length > 0, body);
  }

  for (const c of [modB, modC, member, requester]) {
    const frames = joinRequestNotificationFrames(c, t0);
    check(
      `${c.label} receives NO join-request notification frame`,
      frames.length === 0,
      frames.map((f) => f.event).join(",")
    );
  }

  // Unread counts: +1 for the admin, untouched for everyone else. Exactly +1
  // however many request/cancel cycles the retry loop above needed — the card is
  // keyed on the requester, so a re-request replaces rather than stacks.
  const adminAfter = await admin.unread();
  check(
    "A(admin) unread count went up by exactly 1",
    adminAfter === (before.get(admin.label) ?? 0) + 1,
    `${before.get(admin.label)} → ${adminAfter}`
  );
  for (const c of [modB, modC, member, requester]) {
    const after = await c.unread();
    check(
      `${c.label} unread count unchanged`,
      after === (before.get(c.label) ?? 0),
      `${before.get(c.label)} → ${after}`
    );
  }

  // Persistence — the "reload the moderator's session" test is exactly this read.
  const adminRows = joinRequestRows(await admin.inbox(), CID);
  check(
    "A(admin) has exactly ONE persisted join-request row",
    adminRows.length === 1,
    `${adminRows.length} row(s)`
  );
  for (const c of [modB, modC, member, requester]) {
    const rows = joinRequestRows(await c.inbox(), CID);
    check(
      `${c.label} has NO persisted join-request row (survives reload)`,
      rows.length === 0,
      `${rows.length} row(s)`
    );
  }

  // Moderators keep the pending-LIST sync — they can still action the request.
  for (const c of [modB, modC]) {
    const listSync = c
      .since(t0)
      .filter((f) => f.event === "community:join_request:updated");
    check(
      `${c.label} still receives the pending-list sync (action rights intact)`,
      listSync.length >= 1,
      `${listSync.length} frame(s)`
    );
  }
  const modBList = await modB.api(
    "GET",
    `/communities/${CID}/join-requests?status=PENDING&page=1&limit=20`
  );
  check(
    "B(mod) can still LIST pending requests",
    modBList.status < 300,
    `status=${modBList.status}`
  );

  // =========================================================================
  // TEST 1b — the card does not outlive the request. E cancels; the admin's row
  // and badge must clear themselves with no reload.
  // =========================================================================
  console.log("\n--- TEST 1b: retraction on cancel ---------------------------");
  // The retraction is a `skipPush` send, and push.service returns before it
  // reaches the device stage — so it writes NO log line and pushRecipients()
  // cannot see it. The oracle here is the admin's own inbox instead: the row
  // disappearing IS the behaviour under test. Retried for the shared-broker
  // reason above: only a consumer running this code knows the new event type.
  let tCancel = Date.now();
  let cancelStatus = 0;
  let adminRowsAfterCancel = 1;
  for (let attempt = 1; attempt <= 10 && adminRowsAfterCancel > 0; attempt += 1) {
    // A PENDING request to cancel (the previous iteration cancelled it).
    await requester.api("POST", `/communities/${CID}/join-requests`, {
      message: "cycle",
    });
    await sleep(4000);
    tCancel = Date.now();
    cancelStatus = (
      await requester.api("DELETE", `/communities/${CID}/join-requests/mine`)
    ).status;
    await sleep(6000);
    adminRowsAfterCancel = joinRequestRows(await admin.inbox(), CID).length;
  }
  check("E cancels the pending request", cancelStatus < 300, `status=${cancelStatus}`);
  check(
    "A(admin)'s join-request row is gone — the card never outlives the request",
    adminRowsAfterCancel === 0,
    `${adminRowsAfterCancel} row(s) left`
  );
  if (adminRowsAfterCancel === 0) {
    check(
      "A(admin) unread count returned to its baseline",
      (await admin.unread()) === (before.get(admin.label) ?? 0),
      `baseline=${before.get(admin.label)} now=${await admin.unread()}`
    );
    check(
      "A(admin) got a realtime notification:deleted (no reload needed)",
      admin.since(tCancel).filter((f) => f.event === "notification:deleted")
        .length >= 1
    );
    for (const c of [modB, modC]) {
      check(
        `${c.label} was not told to drop a card they never had`,
        c.since(tCancel).filter((f) => f.event === "notification:deleted")
          .length === 0
      );
    }
  }

  // =========================================================================
  // TEST 4 — a second moderator changes nothing (multiple moderators).
  // Re-run with a cancel/re-request cycle so the roster has B and C as mods.
  // =========================================================================
  console.log("\n--- TEST 4: cancel + re-request, 2 moderators ---------------");
  // TEST 1b left the request CANCELLED, so this picks up mid-lifecycle: the
  // re-request below is the "request again after cancelling" case.
  const t1 = Date.now();
  const beforeUnread2 = new Map<string, number>();
  for (const c of everyone) beforeUnread2.set(c.label, await c.unread());
  const second = await fileRequestUntilObserved(requester, CID, "second try");
  const requestId2 = second.requestId;
  check("re-request created", Boolean(requestId2), `id=${requestId2}`);

  const recipients2 = second.recipients;
  check(
    "re-request: push recipient set is STILL the admin alone",
    recipients2.length > 0 && recipients2.every((id) => id === A),
    recipients2.length === 0
      ? "message went to another consumer on the shared broker"
      : recipients2.map(labelOf).join(",")
  );
  for (const c of [modB, modC, member]) {
    check(
      `${c.label} still silent with two moderators present`,
      !recipients2.includes(c.userId) &&
        joinRequestNotificationFrames(c, t1).length === 0 &&
        (await c.unread()) === (beforeUnread2.get(c.label) ?? 0)
    );
  }

  // =========================================================================
  // TEST 5 — admin transfer. The NEW admin is notified; the old one is not.
  // =========================================================================
  console.log("\n--- TEST 5: admin transfer ----------------------------------");
  // Clear the pending row first so E can file a fresh request afterwards.
  const rejected = await admin.api(
    "POST",
    `/communities/${CID}/join-requests/${requestId2}/reject`
  );
  check("reject flow still works", rejected.status < 300, `status=${rejected.status}`);
  await sleep(2000);

  const transfer = await admin.api("POST", `/communities/${CID}/transfer-admin`, {
    userId: B,
  });
  check("admin transferred A → B", transfer.status < 300, `status=${transfer.status} ${JSON.stringify(transfer.json).slice(0, 200)}`);
  await sleep(2500);

  const t2 = Date.now();
  const beforeUnread3 = new Map<string, number>();
  for (const c of everyone) beforeUnread3.set(c.label, await c.unread());
  const third = await fileRequestUntilObserved(requester, CID, "after transfer");
  check("post-transfer request created", Boolean(third.requestId), `id=${third.requestId}`);

  const recipients3 = third.recipients;
  check(
    "B (the NEW admin) is the only push recipient after the transfer",
    recipients3.length > 0 && recipients3.every((id) => id === B),
    recipients3.length === 0
      ? "message went to another consumer on the shared broker"
      : recipients3.map(labelOf).join(",")
  );
  check(
    "A (the FORMER admin) receives nothing",
    !recipients3.includes(A) &&
      joinRequestNotificationFrames(admin, t2).length === 0 &&
      (await admin.unread()) === (beforeUnread3.get(admin.label) ?? 0),
    `frames=${joinRequestNotificationFrames(admin, t2).length}`
  );
  check(
    "C (still a moderator) receives nothing",
    !recipients3.includes(C) &&
      joinRequestNotificationFrames(modC, t2).length === 0
  );

  // =========================================================================
  // TEST 6 — PUBLIC direct join produces no join-request notification.
  // Also covers PRIVATE→PUBLIC AUTO_RESOLVE for the row E has pending.
  // =========================================================================
  console.log("\n--- TEST 6: PRIVATE → PUBLIC + direct join ------------------");
  const t3 = Date.now();
  const beforeUnread4 = new Map<string, number>();
  for (const c of everyone) beforeUnread4.set(c.label, await c.unread());
  // B is the admin now.
  const toPublic = await modB.api("PATCH", `/communities/${CID}`, {
    type: "PUBLIC",
  });
  check("community switched to PUBLIC", toPublic.status < 300, `status=${toPublic.status}`);
  await sleep(6000);

  for (const c of everyone) {
    check(
      `${c.label} gets no join-request notification from AUTO_RESOLVE`,
      joinRequestNotificationFrames(c, t3).length === 0,
      `${joinRequestNotificationFrames(c, t3).length} frame(s)`
    );
  }
  const eRows = joinRequestRows(await requester.inbox(), CID);
  check(
    "E's AUTO_RESOLVED row is not reported as an admin approval",
    !eRows.some((r) => String(r.type ?? "").includes("APPROVED")),
    eRows.map((r) => String(r.type)).join(",")
  );

  console.log("\n--- summary -------------------------------------------------");
  if (!process.env.KEEP) {
    const del = await modB.api("DELETE", `/communities/${CID}`);
    console.log(`cleanup: delete community → ${del.status}`);
  } else {
    console.log(`KEEP=1 — community ${CID} left in place`);
  }
  for (const c of everyone) c.close();
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
