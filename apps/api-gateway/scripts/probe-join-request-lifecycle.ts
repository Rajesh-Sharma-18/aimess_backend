/**
 * Live probe: does EVERY new PENDING join-request lifecycle reach the admin as a
 * fresh, actionable notification?
 *
 * The reported failure is that only the FIRST request notifies: after
 * request → cancel → request again, the admin's list shows nothing new. This
 * drives the real stack through several request/cancel cycles and records, per
 * cycle, what the admin's inbox actually holds — the row id, whether it is
 * unread, and the action metadata a client needs to render Accept / Reject
 * (`joinRequestId`, `communityId`, `requesterId`, `lifecycle`).
 *
 * A new row id per cycle is the pass condition: an UPDATE in place keeps the id,
 * which is exactly how a second request can be persisted and still be invisible.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> CYCLES=3 pnpm exec tsx \
 *     scripts/probe-join-request-lifecycle.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const API = process.env.GATEWAY_API ?? "http://localhost:3000/api/v1";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const CYCLES = Number(process.env.CYCLES ?? 3);

const ADMIN = process.env.ADMIN_ID ?? "7b0db132-ffff-4d99-ab3c-421f83fba2ef";
const MOD = process.env.MOD_ID ?? "1b98aed5-cc15-41d6-95bb-bef47a44f063";
const REQUESTER = process.env.REQUESTER_ID ?? "246a48a1-8574-40c2-99c2-662343fedc4c";

if (!SECRET) {
  console.error("JWT_ACCESS_SECRET is required.");
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tokenFor = (userId: string): string =>
  signAccessToken({ userId, sessionId: randomUUID(), secret: SECRET, expiresInSeconds: 7200 });

async function api(
  user: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokenFor(user)}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

interface Frame {
  event: string;
  at: number;
  data: Record<string, unknown>;
}

/** An admin session, so "did it arrive without a reload" is answerable. */
async function openSession(userId: string, label: string): Promise<{ frames: Frame[]; close: () => void }> {
  const socket: Socket = io(`${GW}/notify`, {
    transports: ["websocket"],
    auth: { token: tokenFor(userId) },
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (e: Error) => reject(e));
    setTimeout(() => reject(new Error(`${label} connect timeout`)), 10000);
  });
  const frames: Frame[] = [];
  socket.onAny((event: string, ...args: unknown[]) => {
    frames.push({ event, at: Date.now(), data: (args[0] ?? {}) as Record<string, unknown> });
  });
  return { frames, close: () => socket.close() };
}

/** The admin's join-request rows for this community, newest first. */
async function cards(communityId: string): Promise<any[]> {
  const r = await api(ADMIN, "GET", "/chat/notifications?limit=30");
  return (r.json?.data?.data ?? []).filter(
    (n: any) =>
      n.type === "community.join_requested" &&
      (n.payload?.data?.communityId ?? n.data?.communityId) === communityId
  );
}

const actionData = (row: any): Record<string, string> =>
  (row?.payload?.data ?? row?.data ?? {}) as Record<string, string>;

async function main(): Promise<void> {
  const sessionA = await openSession(ADMIN, "admin-A");
  const sessionB = await openSession(ADMIN, "admin-B"); // second admin session
  const modSession = await openSession(MOD, "moderator");

  // --- fixture: PRIVATE community, admin + moderator + outside requester ----
  const cats = await api(ADMIN, "GET", "/communities/categories");
  const categoryId = cats.json.data.categories[0].id;
  const sfx = Math.random().toString(36).slice(2, 8);
  const created = await api(ADMIN, "POST", "/communities", {
    name: `JoinLifecycle ${sfx}`,
    handle: `joinlifecycle${sfx}`,
    type: "PRIVATE",
    categoryId,
  });
  const CID = created.json?.data?.id as string;
  check("fixture: PRIVATE community created", Boolean(CID), `id=${CID}`);
  if (!CID) process.exit(1);

  const link = await api(ADMIN, "POST", `/communities/${CID}/invite-links`, { autoApprove: true });
  await api(MOD, "POST", `/communities/invite-links/${link.json.data.code}/redeem`, {});
  await api(ADMIN, "PUT", `/communities/${CID}/members/${MOD}/role`, { role: "MODERATOR" });

  const seen = new Set<string>();
  let previousId = "";

  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    console.log(`\n--- cycle ${cycle}: request -------------------------------`);
    const t0 = Date.now();
    // Each cycle is a FRESH pending lifecycle: leave no membership or row behind.
    await api(ADMIN, "DELETE", `/communities/${CID}/members/${REQUESTER}`, { reason: "reset" });
    await api(REQUESTER, "DELETE", `/communities/${CID}/join-requests/mine`);
    await sleep(2000);

    // `community.queue` is shared with other machines whose services predate
    // this change, and one message goes to exactly ONE of them. A cycle they
    // handle proves nothing either way, so each attempt is identified by the
    // lifecycle token only the current code emits, and retried until the card
    // that comes back is one THIS code wrote.
    let joinRequestId = "";
    let expectedLifecycle = "";
    let rows: any[] = [];
    let attempts = 0;
    for (let attempt = 1; attempt <= 8 && rows.length === 0; attempt += 1) {
      attempts = attempt;
      if (attempt > 1) {
        await api(REQUESTER, "DELETE", `/communities/${CID}/join-requests/mine`);
        await sleep(1500);
      }
      const req = await api(REQUESTER, "POST", `/communities/${CID}/join-requests`, {
        message: `cycle ${cycle} attempt ${attempt}`,
      });
      joinRequestId = req.json?.data?.requestId as string;
      // Same derivation the producer uses: id + the row's updatedAt in ms.
      expectedLifecycle = `${joinRequestId}:${new Date(req.json?.data?.updatedAt).getTime()}`;
      for (let i = 0; i < 6 && rows.length === 0; i += 1) {
        await sleep(2500);
        rows = (await cards(CID)).filter(
          (n: any) => actionData(n).lifecycle === expectedLifecycle
        );
      }
    }
    check(`cycle ${cycle}: request created`, Boolean(joinRequestId), `id=${joinRequestId} attempts=${attempts}`);

    check(`cycle ${cycle}: admin has a join-request card`, rows.length === 1, `${rows.length} row(s)`);
    if (rows.length === 0) continue;

    const row = rows[0];
    const data = actionData(row);
    check(
      `cycle ${cycle}: card is a NEW row, not the previous one rewritten`,
      !seen.has(row.id),
      `id=${row.id}${previousId ? ` previous=${previousId}` : ""}`
    );
    check(`cycle ${cycle}: card is unread`, row.isRead === false, `isRead=${row.isRead}`);
    check(
      `cycle ${cycle}: card carries the CURRENT joinRequestId`,
      data.requestId === joinRequestId || data.joinRequestId === joinRequestId,
      `card=${data.joinRequestId ?? data.requestId} request=${joinRequestId}`
    );
    check(
      `cycle ${cycle}: card carries the ids an Accept/Reject button needs`,
      Boolean(data.communityId && data.requesterId),
      `communityId=${data.communityId} requesterId=${data.requesterId}`
    );
    check(
      `cycle ${cycle}: card carries THIS attempt's lifecycle token`,
      data.lifecycle === expectedLifecycle,
      `card=${data.lifecycle ?? "(missing)"} expected=${expectedLifecycle}`
    );

    const arrivedLive = sessionA.frames.some(
      (f) => f.at >= t0 && f.event === "notification:new" && JSON.stringify(f.data).includes(joinRequestId)
    );
    check(`cycle ${cycle}: session A saw it arrive live (no reload)`, arrivedLive);
    const secondSession = sessionB.frames.some(
      (f) => f.at >= t0 && f.event === "notification:new" && JSON.stringify(f.data).includes(joinRequestId)
    );
    check(`cycle ${cycle}: session B saw it too`, secondSession);
    const modGot = modSession.frames.filter(
      (f) => f.at >= t0 && f.event.startsWith("notification:") && JSON.stringify(f.data).includes("join_request")
    );
    check(`cycle ${cycle}: moderator got nothing`, modGot.length === 0, `${modGot.length} frame(s)`);

    seen.add(row.id);
    previousId = row.id;

    // --- cancel, which must clear the card again --------------------------
    if (cycle < CYCLES) {
      // Same shared-queue caveat as the request above: retried until the
      // retraction is one this code handled, which is observable as the card
      // actually going away.
      const tCancel = Date.now();
      let left: any[] = rows;
      for (let attempt = 1; attempt <= 8 && left.length > 0; attempt += 1) {
        await api(REQUESTER, "DELETE", `/communities/${CID}/join-requests/mine`);
        for (let i = 0; i < 4 && left.length > 0; i += 1) {
          await sleep(2500);
          left = await cards(CID);
        }
        if (left.length > 0) {
          // Another machine's service swallowed the retraction — raise the
          // attempt again so there is something to cancel on the next pass.
          await api(REQUESTER, "POST", `/communities/${CID}/join-requests`, { message: "retry" });
          await sleep(3000);
        }
      }
      check(`cycle ${cycle}: cancel cleared the admin's card`, left.length === 0, `${left.length} row(s) left`);
      const deleted = sessionA.frames.some((f) => f.at >= tCancel && f.event === "notification:deleted");
      check(`cycle ${cycle}: cancel reached the admin live`, deleted);
    }
  }

  // --- the final pending request is approved from the canonical endpoint ----
  console.log("\n--- approve resolves every surface ---------------------------");
  const pending = await api(ADMIN, "GET", `/communities/${CID}/join-requests?status=PENDING&page=1&limit=5`);
  const row = (pending.json?.data?.data ?? [])[0];
  check("approve: a pending request is listed", Boolean(row), `requestId=${row?.requestId}`);
  if (row) {
    const appr = await api(ADMIN, "POST", `/communities/${CID}/join-requests/${row.requestId}/approve`);
    check("approve: canonical endpoint accepted it", appr.status < 300, `status=${appr.status}`);
    // Retried for the shared-queue reason above: a retraction handled by another
    // machine's older service leaves the card standing, which says nothing about
    // this code. Re-raise and re-approve until one of OUR consumers settles it.
    let left = await cards(CID);
    for (let attempt = 1; attempt <= 6 && left.length > 0; attempt += 1) {
      for (let i = 0; i < 4 && left.length > 0; i += 1) {
        await sleep(2500);
        left = await cards(CID);
      }
      if (left.length === 0) break;
      await api(ADMIN, "DELETE", `/communities/${CID}/members/${REQUESTER}`, { reason: "retry" });
      await sleep(1500);
      await api(REQUESTER, "POST", `/communities/${CID}/join-requests`, { message: "retry" });
      await sleep(5000);
      const pend = await api(ADMIN, "GET", `/communities/${CID}/join-requests?status=PENDING&page=1&limit=5`);
      const again = (pend.json?.data?.data ?? [])[0];
      if (again) {
        await api(ADMIN, "POST", `/communities/${CID}/join-requests/${again.requestId}/approve`);
      }
      left = await cards(CID);
    }
    check("approve: the admin's card is gone", left.length === 0, `${left.length} row(s) left`);
    const members = await api(ADMIN, "GET", `/communities/${CID}/members?limit=20`);
    const joined = (members.json?.data?.data ?? []).filter((m: any) => m.userId === REQUESTER);
    check("approve: exactly one membership", joined.length === 1, `${joined.length} row(s)`);
  }

  if (!process.env.KEEP) {
    const del = await api(ADMIN, "DELETE", `/communities/${CID}`);
    console.log(`cleanup: delete community → ${del.status}`);
  } else {
    console.log(`KEEP=1 — community ${CID} left in place`);
  }
  sessionA.close();
  sessionB.close();
  modSession.close();
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
