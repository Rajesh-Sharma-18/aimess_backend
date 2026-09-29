/**
 * One GIF/sticker selection must be exactly one message — on every chat type.
 *
 * Drives the local gateway as a sender with TWO sockets (two devices) and a
 * receiver, then checks, for GIF and STICKER on community / group / private:
 *   - a single send stores one row;
 *   - a replay storm (the same clientMessageId x5, concurrently, from both
 *     sender devices — an ack-timeout re-emit racing a second tab's outbox)
 *     resolves to ONE message id and ONE row;
 *   - the same GIF sent intentionally twice (two clientMessageIds) is TWO rows;
 *   - 20 one-by-one sends are 20 rows;
 *   - every socket (both sender devices and the receiver) sees exactly one
 *     `message:new` frame per logical message.
 *
 * Usage (from apps/api-gateway, reads JWT_ACCESS_SECRET from .env):
 *   pnpm exec tsx scripts/probe-gif-sticker-dup.ts
 * Override fixtures with USER_A / USER_B / COMMUNITY / GROUP / ROOM / MONGO_URL.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { config } from "dotenv";
import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

config();
// mongodb is a chat-service dependency, not the gateway's.
const { MongoClient } = createRequire(
  new URL("../../chat-service/package.json", import.meta.url)
)("mongodb") as typeof import("mongodb");

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const A = process.env.USER_A ?? "7b0db132-ffff-4d99-ab3c-421f83fba2ef";
const B = process.env.USER_B ?? "1b98aed5-cc15-41d6-95bb-bef47a44f063";
const COMMUNITY = process.env.COMMUNITY ?? "6ab21e7c0c9d8b399a752780";
const GROUP = process.env.GROUP ?? "grp_cftzaOYZkp1vmL1w";
const ROOM = process.env.ROOM ?? "prv_PP3Zn6RX8d-YYwhY";
const MONGO_URL =
  process.env.MONGO_URL ??
  "mongodb://10.0.127.253:27018/aimess_chat?directConnection=true";
const GIF = "https://media4.giphy.com/media/7tFmVu8WDpy9vp6ENC/giphy.gif";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const token = (userId: string) =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: process.env.JWT_ACCESS_SECRET ?? "",
    expiresInSeconds: 3600,
  });

async function connect(ns: string, userId: string): Promise<Socket> {
  const socket = io(`${GW}/${ns}`, {
    auth: { token: token(userId) },
    transports: ["websocket"],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  await new Promise((r) => setTimeout(r, 500));
  return socket;
}

function emitAck(socket: Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (ack: unknown) => resolve(ack ?? {}));
    setTimeout(() => resolve({ timeout: true }), 15_000);
  });
}

const messageIdOf = (ack: any): string => String(ack?.data?.messageId ?? "");

type Media = "GIF" | "STICKER";
const content = (t: Media) =>
  t === "GIF"
    ? { files: [{ url: GIF, mime: "image/gif", width: 200, height: 200 }] }
    : { sticker: { url: GIF, packId: "giphy", stickerId: "7tFmVu8WDpy9vp6ENC" } };

interface Target {
  label: string;
  ns: string;
  sendEvent: string;
  newEvent: string;
  collection: string;
  payload: (clientMessageId: string, t: Media) => unknown;
}

const targets: Target[] = [
  {
    label: "community",
    ns: "community",
    sendEvent: "community:message:send",
    newEvent: "community:message:new",
    collection: "general_room_messages",
    payload: (clientMessageId, t) => ({
      communityId: COMMUNITY,
      roomId: COMMUNITY,
      clientMessageId,
      contentType: t,
      ...(t === "GIF" ? { media: content(t) } : content(t)),
    }),
  },
  {
    label: "group",
    ns: "chat",
    sendEvent: "message:send",
    newEvent: "message:new",
    collection: "group_messages",
    payload: (clientMessageId, t) => ({
      roomId: GROUP,
      clientMessageId,
      contentType: t,
      content: content(t),
    }),
  },
  {
    label: "private",
    ns: "chat",
    sendEvent: "message:send",
    newEvent: "message:new",
    collection: "private_messages",
    payload: (clientMessageId, t) => ({
      roomId: ROOM,
      receiverId: B,
      clientMessageId,
      contentType: t,
      content: content(t),
    }),
  },
];

async function main(): Promise<void> {
  const mongo = new MongoClient(MONGO_URL);
  await mongo.connect();
  const db = mongo.db();
  const rows = (collection: string, clientMessageId: string) =>
    db.collection(collection).countDocuments({ clientMessageId });

  for (const target of targets) {
    const a1 = await connect(target.ns, A);
    const a2 = await connect(target.ns, A);
    const b = await connect(target.ns, B);
    const sockets = { a1, a2, b };
    if (target.ns === "community") {
      for (const s of Object.values(sockets)) {
        await emitAck(s, "community:join", { communityId: COMMUNITY });
      }
    }
    const frames = new Map<string, Map<string, number>>();
    for (const [name, s] of Object.entries(sockets)) {
      const seen = new Map<string, number>();
      frames.set(name, seen);
      s.on(target.newEvent, (p: any) => {
        const key = p?.clientMessageId || `id:${p?.id ?? p?.messageId}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      });
    }
    const newId = () => `probe-dup-${randomUUID()}`;
    const send = (s: Socket, cid: string, t: Media) =>
      emitAck(s, target.sendEvent, target.payload(cid, t));

    for (const t of ["GIF", "STICKER"] as const) {
      const tag = `${target.label}/${t}`;

      const single = newId();
      const singleAck = await send(a1, single, t);

      const storm = newId();
      const stormAcks = await Promise.all(
        [a1, a2, a1, a2, a1].map((s) => send(s, storm, t))
      );

      const twiceA = newId();
      const twiceB = newId();
      const [ackA, ackB] = await Promise.all([send(a1, twiceA, t), send(a1, twiceB, t)]);

      const sequential: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const cid = newId();
        sequential.push(cid);
        await send(a1, cid, t);
      }
      await new Promise((r) => setTimeout(r, 2500));

      check(`${tag} single: stored`, !!messageIdOf(singleAck), JSON.stringify(singleAck).slice(0, 200));
      check(`${tag} single: 1 row`, (await rows(target.collection, single)) === 1);
      const stormIds = new Set(stormAcks.map(messageIdOf));
      check(
        `${tag} replay storm x5: one message id`,
        stormIds.size === 1 && !stormIds.has(""),
        [...stormIds].join(",")
      );
      const stormRows = await rows(target.collection, storm);
      check(`${tag} replay storm x5: 1 row`, stormRows === 1, String(stormRows));
      check(
        `${tag} same GIF intentionally twice: 2 messages`,
        !!messageIdOf(ackA) && !!messageIdOf(ackB) && messageIdOf(ackA) !== messageIdOf(ackB)
      );
      let seqRows = 0;
      for (const cid of sequential) seqRows += await rows(target.collection, cid);
      check(`${tag} 20 one-by-one: 20 rows`, seqRows === 20, String(seqRows));
      for (const [name, seen] of frames) {
        const off = [single, storm, twiceA, twiceB, ...sequential]
          .filter((cid) => (seen.get(cid) ?? 0) !== 1)
          .map((cid) => `${cid.slice(-6)}=${seen.get(cid) ?? 0}`);
        check(`${tag} socket ${name}: one frame per message`, off.length === 0, off.join(" "));
      }
    }
    for (const s of Object.values(sockets)) s.close();
  }
  await mongo.close();
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
