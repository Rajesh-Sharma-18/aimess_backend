/**
 * Lifecycle half of the conversation-list sync check: a community the receiver
 * is ADDED to must reach their list without a reload, and one they have LEFT,
 * been KICKED from or been BANNED out of must NOT come back when a later
 * message bumps it.
 *
 * USER_A creates the community and does all the acting; USER_B is the receiver
 * whose list is under test (the browser session). Everything it creates is
 * throwaway, so it never mutates a shared QA community.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> USER_A=<owner uuid> USER_B=<receiver uuid> \
 *   [CASE=left|kicked|banned|added] pnpm exec tsx scripts/probe-list-sync-lifecycle.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const REST = process.env.GATEWAY_HTTP ?? "http://localhost:3000";
const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const A = process.env.USER_A ?? "";
const B = process.env.USER_B ?? "";
const CASE = (process.env.CASE ?? "left").toLowerCase();

if (!SECRET || !A || !B) {
  console.error("JWT_ACCESS_SECRET, USER_A and USER_B are required.");
  process.exit(2);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const token = (userId: string): string =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 3600,
  });

const tokenA = token(A);
const tokenB = token(B);

async function api(
  method: "GET" | "POST" | "DELETE",
  path: string,
  tok: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${REST}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { status: res.status, json };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function mineIds(tok: string): Promise<string[]> {
  const { json } = await api(
    "GET",
    `/communities/mine?limit=50&cursor=${Date.now()}`,
    tok
  );
  const data = json.data as { data?: { id: string }[] } | undefined;
  return (data?.data ?? []).map((c) => c.id);
}

async function main(): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 8);

  const cats = await api("GET", "/communities/categories", tokenA);
  const catData = cats.json.data as
    | { categories?: { id: string }[]; data?: { id: string }[] }
    | { id: string }[]
    | undefined;
  const categoryId = Array.isArray(catData)
    ? catData[0]?.id
    : (catData?.categories ?? catData?.data ?? [])[0]?.id;
  if (!categoryId) {
    console.error("no community category available", JSON.stringify(cats.json).slice(0, 300));
    process.exit(1);
  }

  const created = await api("POST", "/communities", tokenA, {
    name: `ListSync ${suffix}`,
    handle: `listsync_${suffix}`,
    type: "PRIVATE",
    categoryId,
    description: "throwaway probe community",
  });
  const communityId = (created.json.data as { id?: string } | undefined)?.id;
  if (!communityId) {
    console.error("create failed", created.status, JSON.stringify(created.json).slice(0, 400));
    process.exit(1);
  }
  console.log(`community ${communityId} (ListSync ${suffix}) created by A`);

  // A receiver socket, so the `community:added` fan-out is observable on the wire.
  const frames: { event: string; data: Record<string, unknown> }[] = [];
  const sock: Socket = io(`${GW}/community`, {
    transports: ["websocket"],
    auth: { token: tokenB },
    forceNew: true,
  });
  sock.onAny((event: string, data: unknown) =>
    frames.push({ event, data: (data ?? {}) as Record<string, unknown> })
  );
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("connect_error", (e: Error) => reject(e));
    setTimeout(() => reject(new Error("receiver connect timeout")), 10_000);
  });

  const add = await api("POST", `/communities/${communityId}/members`, tokenA, {
    userIds: [B],
  });
  console.log(`add members → ${add.status}`);
  await sleep(6000);
  check(
    "added → receiver got community:added",
    frames.some(
      (f) => f.event === "community:added" && f.data.communityId === communityId
    ),
    frames.map((f) => f.event).join(",") || "no frames"
  );
  check("added → REST list contains it", (await mineIds(tokenB)).includes(communityId));

  if (CASE !== "added") {
    if (CASE === "left") {
      const left = await api("POST", `/communities/${communityId}/leave`, tokenB, {});
      console.log(`B leaves → ${left.status}`);
    } else if (CASE === "kicked") {
      const kicked = await api(
        "DELETE",
        `/communities/${communityId}/members/${B}`,
        tokenA,
        { reason: "probe" }
      );
      console.log(`A kicks B → ${kicked.status}`);
    } else {
      const banned = await api(
        "POST",
        `/communities/${communityId}/members/${B}/ban`,
        tokenA,
        { reason: "probe" }
      );
      console.log(`A bans B → ${banned.status}`);
    }
    await sleep(6000);
    // A BAN is not a removal: the row deliberately stays in the banned member's
    // list as `isBanned: true, isJoined: false` so the community screen can show
    // the banned notice instead of a dead link. Leaving and being kicked DO drop
    // it. Either way the server is the authority the client's recovery refetch
    // asks, so neither outcome can be produced by a stale bump.
    const stillListed = (await mineIds(tokenB)).includes(communityId);
    check(
      CASE === "banned"
        ? "banned → REST list keeps it (read-only banned row)"
        : `${CASE} → REST list no longer contains it`,
      CASE === "banned" ? stillListed : !stillListed
    );

    // The bump that must NOT resurrect the row.
    const senderSock: Socket = io(`${GW}/community`, {
      transports: ["websocket"],
      auth: { token: tokenA },
      forceNew: true,
    });
    await new Promise<void>((resolve) => senderSock.once("connect", () => resolve()));
    const mark = frames.length;
    await new Promise<void>((resolve) => {
      senderSock.emit(
        "community:message:send",
        {
          communityId,
          contentType: "TEXT",
          message: `post-${CASE} bump ${new Date().toISOString()}`,
          clientMessageId: `probe-lifecycle-${Date.now()}`,
        },
        () => resolve()
      );
      setTimeout(resolve, 8000);
    });
    await sleep(4000);
    const bumped = frames
      .slice(mark)
      .filter((f) => f.event === "community:updated" && f.data.communityId === communityId);
    console.log(
      `   post-${CASE} community:updated frames to B: ${bumped.length}`
    );
    check(
      `${CASE} → the bump does not change what the server lists`,
      (await mineIds(tokenB)).includes(communityId) === stillListed,
      "the server is the authority the client's recovery refetch asks"
    );
    senderSock.close();
  }

  sock.close();
  console.log(`\nCOMMUNITY_ID=${communityId}`);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
