/**
 * Live probe: does the HOST of a livestream get a recipient-style notification
 * for their OWN start / end?
 *
 * Drives the real stack (gateway → stream-service → community-service →
 * notifications-service → chat-service inbox) through one full livestream
 * lifecycle and records, for the host AND for a witness member:
 *   - `notification:new` / `notification:count_update` frames on /notify
 *   - the notification inbox rows written for the event
 *   - the unread count before/after
 *   - the community realtime stream frames (which MUST still reach the host)
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> pnpm exec tsx \
 *     scripts/probe-livestream-self-notification.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const API = process.env.GATEWAY_API ?? "http://localhost:3000/api/v1";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";

const HOST = process.env.HOST_ID ?? "7b0db132-ffff-4d99-ab3c-421f83fba2ef";
const WITNESS = process.env.WITNESS_ID ?? "6dc54785-fbed-474b-a9c8-2d51ea1fe861";
const COMMUNITY = process.env.COMMUNITY_ID ?? "6a321d35afccb246b6e80b6b";

if (!SECRET) {
  console.error("JWT_ACCESS_SECRET is required.");
  process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tokenFor = (userId: string): string =>
  signAccessToken({ userId, sessionId: randomUUID(), secret: SECRET, expiresInSeconds: 7200 });

const tokens = new Map<string, string>();
function token(userId: string): string {
  let t = tokens.get(userId);
  if (!t) {
    t = tokenFor(userId);
    tokens.set(userId, t);
  }
  return t;
}

async function api(
  user: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token(user)}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

interface Frame {
  at: number;
  ns: string;
  event: string;
  data: unknown;
}

/**
 * `fresh` mints a NEW session for the same canonical userId — that is what a
 * second signed-in device is. The host connects twice so the check is "no
 * recipient notification on ANY of the host's sessions", not "none on the one
 * that started the stream".
 */
function connect(
  userId: string,
  ns: string,
  sink: Frame[],
  fresh = false
): Promise<Socket> {
  const socket = io(`${GW}/${ns}`, {
    transports: ["websocket"],
    auth: { token: fresh ? tokenFor(userId) : token(userId) },
    forceNew: true,
  });
  socket.onAny((event: string, data: unknown) => {
    sink.push({ at: Date.now(), ns, event, data });
  });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

async function inbox(userId: string): Promise<any[]> {
  const { json } = await api(userId, "GET", "/chat/notifications?limit=30");
  return json?.data?.data ?? [];
}

async function unread(userId: string): Promise<unknown> {
  const { json } = await api(userId, "GET", "/chat/notifications/unread-count");
  return json?.data ?? json;
}

function livestreamRows(rows: any[], livestreamId: string): any[] {
  return rows.filter(
    (r) =>
      typeof r?.type === "string" &&
      r.type.startsWith("community.livestream") &&
      JSON.stringify(r).includes(livestreamId)
  );
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const notifFrames = (frames: Frame[]): Frame[] =>
  frames.filter((f) => f.event === "notification:new" || f.event === "notification:count_update");
const streamFrames = (frames: Frame[], phase: string): Frame[] =>
  frames.filter((f) => f.event === `community:stream:${phase.toLowerCase() === "start" ? "started" : "ended"}`);

/** One phase's verdict across both host sessions and the witness. */
function report(
  phase: "START" | "END",
  host1: Frame[],
  host2: Frame[],
  witness: Frame[],
  after: { hostInbox: any[]; witnessInbox: any[]; hostUnread: any; witnessUnread: any },
  before: { host: any; witness: any }
): void {
  const wire = phase === "START" ? "started" : "ended";
  console.log(`\n--- verdict: ${phase} ---`);
  check(`${phase}: host has no own livestream inbox row`, after.hostInbox.length === 0);
  check(
    `${phase}: host device 1 got no notification frame`,
    notifFrames(host1).length === 0,
    JSON.stringify(notifFrames(host1).map((f) => f.event))
  );
  check(
    `${phase}: host device 2 (other session) got no notification frame`,
    notifFrames(host2).length === 0,
    JSON.stringify(notifFrames(host2).map((f) => f.event))
  );
  check(
    `${phase}: host unread count unchanged`,
    JSON.stringify(after.hostUnread) === JSON.stringify(before.host),
    `${JSON.stringify(before.host)} → ${JSON.stringify(after.hostUnread)}`
  );
  check(
    `${phase}: host device 1 still receives stream state`,
    host1.some((f) => f.event === `community:stream:${wire}`)
  );
  check(
    `${phase}: host device 2 still receives stream state`,
    host2.some((f) => f.event === `community:stream:${wire}`)
  );
  check(
    `${phase}: witness received the livestream notification`,
    after.witnessInbox.some((r) => r.type === `community.livestream_${wire}`)
  );
  check(
    `${phase}: witness got exactly one notification:new for it`,
    witness.filter(
      (f) =>
        f.event === "notification:new" &&
        (f.data as { type?: string })?.type === `community.livestream_${wire}`
    ).length === 1
  );
}

async function main(): Promise<void> {
  const frames: Frame[] = [];
  const hostFrames: Frame[] = [];
  const hostDevice2Frames: Frame[] = [];
  const witnessFrames: Frame[] = [];

  const sockets = await Promise.all([
    connect(HOST, "notify", hostFrames),
    connect(HOST, "community", hostFrames),
    connect(WITNESS, "notify", witnessFrames),
    connect(WITNESS, "community", witnessFrames),
    // Second host device (own session): must see stream STATE, never a
    // recipient notification.
    connect(HOST, "notify", hostDevice2Frames, true),
    connect(HOST, "community", hostDevice2Frames, true),
  ]);
  // Join the community room so the realtime stream banner is observable.
  sockets[1].emit("community:join", { communityId: COMMUNITY });
  sockets[3].emit("community:join", { communityId: COMMUNITY });
  sockets[5].emit("community:join", { communityId: COMMUNITY });
  await sleep(1000);

  const before = {
    host: await unread(HOST),
    witness: await unread(WITNESS),
  };
  console.log("unread BEFORE:", JSON.stringify(before));

  const created = await api(HOST, "POST", "/streams", {
    communityId: COMMUNITY,
    title: `probe self-notification ${new Date().toISOString()}`,
    sourceType: "YOUTUBE",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  console.log("POST /streams →", created.status, JSON.stringify(created.json).slice(0, 400));
  const streamId = created.json?.data?.id ?? created.json?.data?.stream?.id;
  if (!streamId) {
    console.error("no stream id — aborting");
    process.exit(1);
  }
  console.log("streamId:", streamId);

  const live = await api(HOST, "POST", `/streams/${streamId}/go-live`);
  console.log("POST go-live →", live.status, JSON.stringify(live.json).slice(0, 300));

  await sleep(8000);

  const afterStart = {
    hostInbox: livestreamRows(await inbox(HOST), streamId),
    witnessInbox: livestreamRows(await inbox(WITNESS), streamId),
    hostUnread: await unread(HOST),
    witnessUnread: await unread(WITNESS),
  };
  console.log("\n===== AFTER START =====");
  console.log("host livestream inbox rows:", afterStart.hostInbox.length, JSON.stringify(afterStart.hostInbox.map((r) => r.type)));
  console.log("witness livestream inbox rows:", afterStart.witnessInbox.length, JSON.stringify(afterStart.witnessInbox.map((r) => r.type)));
  console.log("host unread:", JSON.stringify(afterStart.hostUnread));
  console.log("witness unread:", JSON.stringify(afterStart.witnessUnread));
  console.log("host frames:", JSON.stringify(hostFrames.map((f) => `${f.ns}:${f.event}`)));
  console.log("witness frames:", JSON.stringify(witnessFrames.map((f) => `${f.ns}:${f.event}`)));
  for (const f of hostFrames.filter((f) => f.event.startsWith("notification"))) {
    console.log("HOST notify frame:", f.event, JSON.stringify(f.data).slice(0, 300));
  }
  report("START", hostFrames, hostDevice2Frames, witnessFrames, afterStart, before);

  const stopped = await api(HOST, "POST", `/streams/${streamId}/stop`);
  console.log("\nPOST stop →", stopped.status, JSON.stringify(stopped.json).slice(0, 200));

  await sleep(8000);

  const afterEnd = {
    hostInbox: livestreamRows(await inbox(HOST), streamId),
    witnessInbox: livestreamRows(await inbox(WITNESS), streamId),
    hostUnread: await unread(HOST),
    witnessUnread: await unread(WITNESS),
  };
  console.log("\n===== AFTER END =====");
  console.log("host livestream inbox rows:", afterEnd.hostInbox.length, JSON.stringify(afterEnd.hostInbox.map((r) => r.type)));
  console.log("witness livestream inbox rows:", afterEnd.witnessInbox.length, JSON.stringify(afterEnd.witnessInbox.map((r) => r.type)));
  console.log("host unread:", JSON.stringify(afterEnd.hostUnread));
  console.log("witness unread:", JSON.stringify(afterEnd.witnessUnread));
  console.log("host frames:", JSON.stringify(hostFrames.map((f) => `${f.ns}:${f.event}`)));
  console.log("witness frames:", JSON.stringify(witnessFrames.map((f) => `${f.ns}:${f.event}`)));
  for (const f of hostFrames.filter((f) => f.event.startsWith("notification"))) {
    console.log("HOST notify frame:", f.event, JSON.stringify(f.data).slice(0, 400));
  }
  for (const f of witnessFrames.filter((f) => f.event.startsWith("notification"))) {
    console.log("WITNESS notify frame:", f.event, JSON.stringify(f.data).slice(0, 200));
  }
  report("END", hostFrames, hostDevice2Frames, witnessFrames, afterEnd, before);
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  void frames;
  for (const s of sockets) s.close();
  process.exit(0);
}

void main();
