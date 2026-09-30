/**
 * Peak concurrent viewers, end to end against the running dev stack.
 *
 * Reproduces the QA report ("Peak viewers: 0" on the Stream ended summary) by
 * driving a real livestream through a real concurrent-viewer sequence:
 *
 *   create → go-live → N sockets join/leave on /stream → stop
 *
 * and printing what `POST /streams/:id/stop` actually returns, which is what
 * the Stream ended modal renders.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> HOST=<uuid> COMMUNITY=<id> \
 *   pnpm exec tsx scripts/probe-peak-viewers.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const HOST = process.env.HOST_USER ?? "";
const COMMUNITY = process.env.COMMUNITY ?? "";

if (!SECRET || !HOST || !COMMUNITY) {
  console.error("JWT_ACCESS_SECRET, HOST_USER and COMMUNITY are required.");
  process.exit(2);
}

const token = (userId: string): string =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 3600,
  });

const hostToken = token(HOST);

async function api(
  method: string,
  path: string,
  bearer: string,
  body?: unknown
): Promise<any> {
  const res = await fetch(`${GW}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${String(res.status)} ${JSON.stringify(json)}`
    );
  }
  return json;
}

/** One viewer socket, already joined to the stream room. */
async function joinViewer(streamId: string, userId: string): Promise<Socket> {
  const socket = io(`${GW}/stream`, {
    transports: ["websocket"],
    auth: { token: token(userId) },
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => {
      resolve();
    });
    socket.on("connect_error", reject);
    setTimeout(() => {
      reject(new Error(`connect timeout for ${userId}`));
    }, 10_000);
  });
  const ack = await new Promise<any>((resolve, reject) => {
    socket.emit("stream:join", { streamId }, resolve);
    setTimeout(() => {
      reject(new Error(`join timeout for ${userId}`));
    }, 10_000);
  });
  if (ack?.success === false) {
    throw new Error(`join refused for ${userId}: ${JSON.stringify(ack)}`);
  }
  return socket;
}

function leave(socket: Socket, streamId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    socket.emit("stream:leave", { streamId }, () => {
      socket.disconnect();
      resolve();
    });
    setTimeout(resolve, 5_000);
  });
}

// The write behind the peak is fire-and-forget from the gateway, so give the
// join's gRPC hop a beat to land before the next step reads the number.
const settle = (ms = 800): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const created = await api("POST", "/streams", hostToken, {
    communityId: COMMUNITY,
    title: `peak-viewers probe ${new Date().toISOString()}`,
    sourceType: "PHONE_CAMERA",
  });
  const streamId: string = created?.data?.id ?? created?.id;
  console.log(`stream ${streamId} created`);

  await api("POST", `/streams/${streamId}/go-live`, hostToken);
  console.log("stream LIVE");

  // Concurrency sequence: 3 → 8 → 4 → 6 → 0. Expected peak = 8.
  const viewers: Socket[] = [];
  const ids = Array.from({ length: 8 }, () => randomUUID());
  const report = async (label: string): Promise<void> => {
    await settle();
    const s = await api("GET", `/streams/${streamId}`, hostToken);
    const row = s?.data ?? s;
    console.log(
      `${label}: sockets=${String(viewers.length)} peakViewers=${String(row.peakViewers)} totalViews=${String(row.totalViews)}`
    );
  };

  for (const id of ids.slice(0, 3)) viewers.push(await joinViewer(streamId, id));
  await report("after 3 join ");

  for (const id of ids.slice(3, 8)) viewers.push(await joinViewer(streamId, id));
  await report("after 8 total");

  for (let i = 0; i < 4; i += 1) await leave(viewers.pop()!, streamId);
  await report("after 4 left ");

  for (const id of ids.slice(3, 5)) viewers.push(await joinViewer(streamId, id));
  await report("back up to 6");

  while (viewers.length > 0) await leave(viewers.pop()!, streamId);
  await report("all left (0)");

  const stopped = await api("POST", `/streams/${streamId}/stop`, hostToken);
  const row = stopped?.data ?? stopped;
  console.log("\n--- Stream ended summary (what the modal renders) ---");
  console.log({
    status: row.status,
    viewerCount: row.viewerCount,
    peakViewers: row.peakViewers,
    totalViews: row.totalViews,
    totalComments: row.totalComments,
  });
  console.log(
    row.peakViewers === 8
      ? "\nPASS — peak preserved at 8 through the drop to 0 viewers."
      : `\nFAIL — expected peakViewers 8, got ${String(row.peakViewers)}`
  );
  process.exit(row.peakViewers === 8 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
