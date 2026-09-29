/**
 * Live probe: does ONE Super-Admin announcement raise a freshly-logged-in
 * session's unread badge by exactly ONE?
 *
 * Reproduces the reported sequence against the running stack:
 *
 *   register a fresh account
 *   login A                     (first session)
 *   login B                     -> a "Login Detected" row for B, which B's own
 *                                 list and /unread-count correctly withhold
 *                                 from B while A correctly sees it
 *   B: GET /unread-count        -> the baseline the badge starts from
 *   B: connect /notify          -> the `notification:count` connect frame
 *   publish ONE announcement batch naming B's user
 *   B: every /notify frame      -> how many count-bearing frames, carrying what
 *   B: GET /unread-count again  -> the server's own answer for B
 *   the list API                -> how many announcement rows actually exist
 *
 * Then the same again with the SAME batch published TWICE, which is what a
 * broker redelivery looks like.
 *
 * The bug this exists to catch is a count-bearing socket frame that disagrees
 * with `/unread-count` for the SAME session: a badge of 2 for one row.
 *
 * Usage (from apps/api-gateway):
 *   pnpm exec tsx scripts/probe-announcement-unread-badge.ts
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import Redis from "ioredis";
import { io, type Socket } from "socket.io-client";

// `amqplib` is not an api-gateway dependency (nothing in the gateway talks to
// the broker); resolved out of the workspace store so this probe stays a single
// file rather than a second script in another package.
const amqp = (await import(
  "../../../node_modules/.pnpm/amqplib@2.0.1/node_modules/amqplib/channel_api.js"
)) as typeof import("amqplib");

const API = process.env.GATEWAY_API ?? "http://127.0.0.1:3000/api/v1";
const WS = process.env.GATEWAY_WS ?? "http://127.0.0.1:3000";
const RABBITMQ_URL = process.env.PROBE_RABBITMQ_URL ?? "";
const REDIS_URL = process.env.PROBE_REDIS_URL ?? "redis://10.0.127.253:6379";
const ANNOUNCEMENT_QUEUE = "notification.announcement.queue";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
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

interface Sess {
  label: string;
  token: string;
  sessionId: string;
  userId: string;
}

function claims(token: string): { sid?: string; sub?: string; userId?: string } {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8")
  );
}

/**
 * `POST /auth/login` is IP-throttled at 15 per 5 minutes and the dev gateway's
 * bucket is shared with the website dev server, so a re-runnable probe has to
 * wait the window out rather than fail on someone else's traffic.
 */
async function login(
  account: string,
  password: string,
  label: string
): Promise<Sess> {
  let r = await call("POST", "/auth/login", {
    account,
    password,
    device: device(
      `probe-${label}-${randomBytes(4).toString("hex")}`,
      `Probe ${label}`
    ),
  });
  for (let attempt = 0; r.status === 429 && attempt < 4; attempt++) {
    const wait = (Number(r.json?.error?.retryAfter) || 30) + 3;
    console.log(`  login ${label} rate-limited; waiting ${wait}s`);
    await sleep(wait * 1000);
    r = await call("POST", "/auth/login", {
      account,
      password,
      device: device(
        `probe-${label}-${randomBytes(4).toString("hex")}`,
        `Probe ${label}`
      ),
    });
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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

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

interface Frame {
  event: string;
  at: number;
  data: any;
}

function connectNotify(s: Sess): { socket: Socket; frames: Frame[] } {
  const frames: Frame[] = [];
  const socket = io(`${WS}/notify`, {
    transports: ["websocket"],
    auth: { token: s.token },
    extraHeaders: { Authorization: `Bearer ${s.token}` },
  });
  socket.onAny((event: string, ...args: unknown[]) => {
    frames.push({ event, at: Date.now(), data: args[0] });
  });
  return { socket, frames };
}

const COUNT_BEARING = new Set([
  "notification:count",
  "notification:count_update",
  "notification:new",
  "notification:read",
  "notification:all-read",
  "notification:deleted",
]);

function describe(frames: Frame[]): string {
  const parts = frames
    .filter((f) => COUNT_BEARING.has(f.event))
    .map(
      (f) =>
        `${f.event}(unread=${String(f.data?.unreadCount)}` +
        `${f.data?.count !== undefined ? `,count=${String(f.data.count)}` : ""}` +
        `${f.data?.notificationId ? `,id=${String(f.data.notificationId)}` : ""}` +
        `${
          f.data?.selfHiddenSessions
            ? `,selfHidden=${JSON.stringify(f.data.selfHiddenSessions)}`
            : ""
        })`
    );
  return parts.join(" ") || "(none)";
}

/** Every unreadCount a badge-following client would have applied, in order. */
function appliedCounts(frames: Frame[]): number[] {
  return frames
    .filter((f) => COUNT_BEARING.has(f.event))
    .map((f) => f.data?.unreadCount)
    .filter((n): n is number => typeof n === "number");
}

/**
 * CreateNotification straight against THIS tree's chat-service, so the publisher
 * of the resulting frame is not in doubt. The announcement queue is served by
 * competing consumers on the shared dev broker and each of those talks to its
 * OWN chat-service, so a frame that arrived from the queue proves nothing about
 * the code here.
 */
function chatNotificationClient(): {
  createNotification: (req: Record<string, unknown>) => Promise<{ id: string }>;
} {
  const protoPath = fileURLToPath(
    new URL(
      "../../../packages/grpc-contracts/proto/notification.proto",
      import.meta.url
    )
  );
  const def = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: Number,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as any;
  const Svc =
    pkg.notification?.NotificationService ??
    pkg.chat?.NotificationService ??
    Object.values(pkg)
      .map((ns: any) => ns?.NotificationService)
      .find(Boolean);
  const client = new Svc(
    process.env.PROBE_CHAT_GRPC ?? "127.0.0.1:4004",
    grpc.credentials.createInsecure()
  );
  const meta = new grpc.Metadata();
  meta.set(
    "x-aimess-service-token",
    process.env.PROBE_GRPC_SERVICE_TOKEN ?? "dev-grpc-service-token-change-me"
  );
  return {
    createNotification: (req) =>
      new Promise((resolve, reject) => {
        client.createNotification(req, meta, (err: unknown, res: any) =>
          err ? reject(err) : resolve(res)
        );
      }),
  };
}

async function publishAnnouncementBatch(
  userIds: string[],
  announcementId: string,
  copies = 1
): Promise<void> {
  const connection = await amqp.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();
  await channel.assertQueue(ANNOUNCEMENT_QUEUE, { durable: true });
  for (let i = 0; i < copies; i++) {
    channel.sendToQueue(
      ANNOUNCEMENT_QUEUE,
      Buffer.from(
        JSON.stringify({
          type: "notification.announcement_batch",
          data: {
            announcementId,
            title: `Probe announcement ${announcementId.slice(0, 8)}`,
            body: `probe body ${announcementId}`,
            kind: "ANNOUNCEMENT",
            deviceType: "ALL",
            userIds,
            batchId: `ann:${announcementId}:notify:0`,
          },
        })
      ),
      { persistent: true }
    );
  }
  await channel.close();
  await connection.close();
}

/** Publish one announcement and wait for it to land on this session. */
async function sendAnnouncement(
  s: Sess,
  frames: Frame[],
  copies: number
): Promise<{ annId: string; after: Frame[] }> {
  const annId = randomUUID();
  const before = frames.length;
  await publishAnnouncementBatch([s.userId], annId, copies);
  for (let i = 0; i < 25; i++) {
    await sleep(1200);
    if (frames.slice(before).some((f) => f.event === "notification:new")) break;
  }
  // Let a SECOND frame arrive if one is coming - the whole point.
  await sleep(4000);
  return { annId, after: frames.slice(before) };
}

async function main(): Promise<void> {
  if (!RABBITMQ_URL) throw new Error("set PROBE_RABBITMQ_URL");

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
  console.log(`account=${account}`);

  const A = await login(account, password, "A");
  await sleep(1500);
  const B = await login(account, password, "B");

  // The RAW publish, before the gateway rewrites it per socket. This is the one
  // way to tell a publisher that forgot `selfHiddenSessions` apart from a
  // gateway that failed to apply it - both reach the client as a bare count.
  const raw: { event: string; data: any }[] = [];
  const sub = new Redis(REDIS_URL);
  await sub.subscribe(`notify:${B.userId}`);
  sub.on("message", (_c, m) => {
    try {
      raw.push(JSON.parse(m));
    } catch {
      /* ignore */
    }
  });
  console.log(
    `user=${B.userId}\nA.session=${A.sessionId}\nB.session=${B.sessionId}`
  );

  // RabbitMQ -> notifications-service -> chat-service is async.
  await sleep(8000);

  const loginRowsB = (await rows(B)).filter(
    (n) => n.type === "auth.security_new_login"
  );
  const loginRowsA = (await rows(A)).filter(
    (n) => n.type === "auth.security_new_login"
  );
  console.log(
    `login rows visible: A=${loginRowsA.length} B=${loginRowsB.length}` +
      ` (B's own alert must be hidden from B)`
  );

  const baseline = await unreadCount(B);
  console.log(`\n[baseline] B /unread-count = ${baseline}`);

  const { socket, frames } = connectNotify(B);
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", (e) => reject(new Error(String(e))));
    setTimeout(() => reject(new Error("notify connect timeout")), 15000);
  });
  await sleep(2500);
  console.log(`[connect] ${describe(frames)}`);
  const connectCount = frames.find((f) => f.event === "notification:count")
    ?.data?.unreadCount;
  check(
    "connect frame agrees with /unread-count",
    connectCount === baseline,
    `socket=${String(connectCount)} rest=${baseline}`
  );

  const describeRaw = (from: number): string =>
    raw
      .slice(from)
      .map(
        (p) =>
          `${p.event}(unread=${String(p.data?.unreadCount)}` +
          `,selfHidden=${JSON.stringify(p.data?.selfHiddenSessions)})`
      )
      .join(" ") || "(none)";

  // ---- announcement 1: single delivery ------------------------------------
  const rawBefore1 = raw.length;
  const one = await sendAnnouncement(B, frames, 1);
  console.log(`\n[announcement 1] ${one.annId}\n  ${describe(one.after)}`);
  console.log(`  RAW publish: ${describeRaw(rawBefore1)}`);
  const rest1 = await unreadCount(B);
  const rows1 = (await rows(B)).filter(
    (n) =>
      n.payload?.data?.announcementId === one.annId ||
      n.data?.announcementId === one.annId
  );
  const new1 = one.after.filter((f) => f.event === "notification:new");
  const applied1 = appliedCounts(one.after);
  console.log(
    `  list rows=${rows1.length} notification:new frames=${new1.length}` +
      ` /unread-count=${rest1} applied=${JSON.stringify(applied1)}`
  );

  if (new1.length === 0) {
    console.log(
      "\nNo notification:new reached this session - the shared broker handed the\n" +
        "batch to another consumer, or notifications-service is down. Re-run."
    );
    socket.close();
    process.exit(2);
  }

  check("ONE list row for the announcement", rows1.length === 1, `rows=${rows1.length}`);
  check("ONE notification:new frame", new1.length === 1, `frames=${new1.length}`);
  check(
    "/unread-count rose by exactly 1",
    rest1 === baseline + 1,
    `${baseline} -> ${rest1}`
  );
  check(
    "every frame agrees with /unread-count",
    applied1.every((n) => n === rest1),
    `applied=${JSON.stringify(applied1)} rest=${rest1}`
  );
  check(
    "badge a client would show = baseline + 1",
    applied1.at(-1) === baseline + 1,
    `badge=${String(applied1.at(-1))} expected=${baseline + 1}`
  );

  // ---- announcement 2: duplicate broker delivery of the SAME batch --------
  const rawBefore2 = raw.length;
  const two = await sendAnnouncement(B, frames, 2);
  console.log(`\n[announcement 2, published twice] ${two.annId}\n  ${describe(two.after)}`);
  console.log(`  RAW publish: ${describeRaw(rawBefore2)}`);
  const rest2 = await unreadCount(B);
  const rows2 = (await rows(B)).filter(
    (n) =>
      n.payload?.data?.announcementId === two.annId ||
      n.data?.announcementId === two.annId
  );
  const applied2 = appliedCounts(two.after);
  console.log(
    `  list rows=${rows2.length} /unread-count=${rest2}` +
      ` applied=${JSON.stringify(applied2)}`
  );
  check("duplicate delivery still ONE list row", rows2.length === 1, `rows=${rows2.length}`);
  check(
    "duplicate delivery still +1",
    rest2 === rest1 + 1,
    `${rest1} -> ${rest2}`
  );
  check(
    "duplicate delivery: every frame agrees with /unread-count",
    applied2.every((n) => n === rest2),
    `applied=${JSON.stringify(applied2)} rest=${rest2}`
  );

  // ---- announcement 3: published by THIS tree's chat-service only ---------
  const rawBefore3 = raw.length;
  const before3 = frames.length;
  const ann3 = randomUUID();
  await chatNotificationClient().createNotification({
    userId: B.userId,
    actorId: "",
    type: "ANNOUNCEMENT",
    title: `Probe announcement ${ann3.slice(0, 8)}`,
    body: `probe body ${ann3}`,
    data: { announcementId: ann3, type: "ANNOUNCEMENT" },
  });
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    if (frames.slice(before3).some((f) => f.event === "notification:new")) break;
  }
  await sleep(3000);
  const after3 = frames.slice(before3);
  const rest3 = await unreadCount(B);
  const applied3 = appliedCounts(after3);
  console.log(
    `\n[announcement 3, direct gRPC to this chat-service] ${ann3}\n  ${describe(after3)}`
  );
  console.log(`  RAW publish: ${describeRaw(rawBefore3)}`);
  console.log(`  /unread-count=${rest3} applied=${JSON.stringify(applied3)}`);
  check(
    "direct publish: every frame agrees with /unread-count",
    applied3.length > 0 && applied3.every((n) => n === rest3),
    `applied=${JSON.stringify(applied3)} rest=${rest3}`
  );
  check(
    "direct publish: /unread-count rose by exactly 1",
    rest3 === rest2 + 1,
    `${rest2} -> ${rest3}`
  );

  // ---- the read path, which cannot be served by any other instance --------
  //
  // The announcement above travels over a queue the shared dev broker hands to
  // whichever notifications-service wins it, so its `notification:new` frame may
  // have been published by a teammate's older chat-service. `POST /read` goes
  // gateway -> THIS chat-service over REST, so the frame it produces is
  // unambiguously built by the code in this working tree.
  const target = rows2[0]?.id;
  if (target) {
    const readBefore = frames.length;
    const rawReadBefore = raw.length;
    const readRes = await call(
      "POST",
      "/chat/notifications/read",
      { notificationIds: [target] },
      B.token
    );
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      if (
        frames
          .slice(readBefore)
          .some((f) => f.event === "notification:read")
      )
        break;
    }
    await sleep(2000);
    console.log(`  RAW publish: ${describeRaw(rawReadBefore)}`);
    const readFrames = frames.slice(readBefore);
    const readRest = readRes.json?.data?.unreadCount;
    const appliedRead = appliedCounts(readFrames);
    console.log(
      `\n[mark read] ${target}\n  ${describe(readFrames)}` +
        `\n  POST /read response unreadCount=${String(readRest)} applied=${JSON.stringify(appliedRead)}`
    );
    check(
      "read frames agree with the read response for this session",
      appliedRead.length > 0 && appliedRead.every((n) => n === readRest),
      `applied=${JSON.stringify(appliedRead)} response=${String(readRest)}`
    );
    const restAfterRead = await unreadCount(B);
    check(
      "/unread-count agrees with the read response",
      restAfterRead === readRest,
      `rest=${restAfterRead} response=${String(readRest)}`
    );
  }

  socket.close();
  sub.disconnect();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
