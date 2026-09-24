/**
 * Reproduces "the community I am chatting in is missing from my community list".
 *
 * `GET /communities/mine?cursor=<epoch-ms>` pages the joined list on
 * `lastActivityAt < cursor`. Web and mobile clients stamp that cursor with their
 * OWN wall clock, so every community whose last activity is newer than the
 * client believes "now" to be is filtered out of that client's own list — and
 * the community it just posted in is exactly the one in that window. With a
 * single membership the screen renders "No communities yet" while the chat room
 * it names is open next to it.
 *
 * The probe sends a message (so `lastActivityAt` becomes server-now), then asks
 * for the list twice: once with a cursor a skewed client would send, once with
 * the server's own clock.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> USER_A=<sender uuid> USER_B=<lister uuid> \
 *   COMMUNITY=<id> [SKEW_MS=5000] pnpm exec tsx scripts/probe-mine-cursor-skew.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const REST = process.env.GATEWAY_HTTP ?? "http://localhost:3000";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const A = process.env.USER_A ?? "";
const B = process.env.USER_B ?? "";
const COMMUNITY = process.env.COMMUNITY ?? "";
const SKEW_MS = Number(process.env.SKEW_MS ?? "5000");

if (!SECRET || !A || !B || !COMMUNITY) {
  console.error(
    "JWT_ACCESS_SECRET, USER_A, USER_B and COMMUNITY are required."
  );
  process.exit(2);
}

const token = (userId: string): string =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 3600,
  });

const tokenB = token(B);
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function mine(query: string): Promise<string[]> {
  const res = await fetch(`${REST}/api/v1/communities/mine?${query}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  const json = (await res.json()) as {
    data?: { data?: { id: string; lastActivityAt: number }[] };
  };
  return (json.data?.data ?? []).map((c) => c.id);
}

async function main(): Promise<void> {
  const sender: Socket = io(`${GW}/community`, {
    transports: ["websocket"],
    auth: { token: token(A) },
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    sender.once("connect", () => resolve());
    sender.once("connect_error", (e: Error) => reject(e));
    setTimeout(() => reject(new Error("sender connect timeout")), 10_000);
  });

  await new Promise<void>((resolve) => {
    sender.emit(
      "community:message:send",
      {
        communityId: COMMUNITY,
        contentType: "TEXT",
        message: `cursor-skew probe ${new Date().toISOString()}`,
        clientMessageId: `probe-skew-${Date.now()}`,
      },
      () => resolve()
    );
    setTimeout(resolve, 8000);
  });
  await sleep(2000);
  sender.close();

  const serverNow = Date.now();
  const skewed = serverNow - SKEW_MS;

  const withSkewedClock = await mine(`limit=50&cursor=${skewed}`);
  const withServerClock = await mine(`limit=50&cursor=${serverNow + 60_000}`);
  const asNewest = await mine(`limit=50&cursor=now`);

  console.log(
    `   skewed cursor (client ${SKEW_MS}ms behind): ${withSkewedClock.length} rows`
  );
  console.log(`   cursor ahead of the activity:            ${withServerClock.length} rows`);
  console.log(`   cursor=now (server clock):               ${asNewest.length} rows`);

  check(
    "a community bumped just now is listed when the cursor is not behind it",
    withServerClock.includes(COMMUNITY)
  );
  check(
    "cursor=now resolves against the SERVER clock, so the bump is listed",
    asNewest.includes(COMMUNITY),
    "this is the fix: the client no longer stamps its own clock into the boundary"
  );
  console.log(
    withSkewedClock.includes(COMMUNITY)
      ? "   (a raw skewed epoch-ms cursor still hides it — that is the documented boundary, which is why clients must send `now`)"
      : "   reproduced: the skewed epoch-ms cursor hides the community the user is chatting in"
  );

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
