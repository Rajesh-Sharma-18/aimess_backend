/**
 * The reported sequence, end to end: media → text → read the list back the way
 * a hard reload does.
 *
 * Checks that the community stays listed throughout, that `lastActivity` walks
 * Photo → text, and that the realtime row and the reloaded row agree. The media
 * is a real presign → PUT → confirm of real bytes, because chat-service refuses
 * an attachment that is not CLEAN.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> USER_A=<sender uuid> USER_B=<receiver uuid> \
 *   COMMUNITY=<id> pnpm exec tsx scripts/probe-media-then-text-list.ts
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

if (!SECRET || !A || !B || !COMMUNITY) {
  console.error("JWT_ACCESS_SECRET, USER_A, USER_B and COMMUNITY are required.");
  process.exit(2);
}

// 1x1 PNG — media-service checks magic bytes AND structure, so it has to be real.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

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

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

interface MineRow {
  id: string;
  lastActivityAt: number;
  lastActivity?: { preview?: string; contentType?: string | null } | null;
}

/** The list exactly as a hard reload reads it. */
async function mine(cursor: string): Promise<MineRow[]> {
  const res = await fetch(
    `${REST}/api/v1/communities/mine?limit=50&cursor=${cursor}`,
    { headers: { Authorization: `Bearer ${tokenB}` } }
  );
  const json = (await res.json()) as { data?: { data?: MineRow[] } };
  return json.data?.data ?? [];
}

const rowOf = (rows: MineRow[]) => rows.find((r) => r.id === COMMUNITY);

async function uploadPng(): Promise<Record<string, unknown>> {
  const auth = {
    authorization: `Bearer ${tokenA}`,
    "content-type": "application/json",
  };
  const s1 = await fetch(`${REST}/api/v1/media/upload-url`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      category: "COMMUNITY_CHAT_ATTACHMENT",
      contentType: "image/png",
      contentLength: PNG.length,
      resourceId: COMMUNITY,
    }),
  });
  const j1 = (await s1.json()) as {
    data?: { uploadUrl: string; objectKey: string };
  };
  if (!s1.ok || !j1.data) {
    throw new Error(`upload-url ${s1.status}: ${JSON.stringify(j1).slice(0, 300)}`);
  }
  const put = await fetch(j1.data.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(PNG),
  });
  if (!put.ok) throw new Error(`PUT ${put.status}`);
  const conf = await fetch(`${REST}/api/v1/media/confirm`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      objectKey: j1.data.objectKey,
      category: "COMMUNITY_CHAT_ATTACHMENT",
      contentType: "image/png",
    }),
  });
  const cj = (await conf.json()) as { data?: Record<string, unknown> };
  if (!conf.ok || !cj.data) {
    throw new Error(`confirm ${conf.status}: ${JSON.stringify(cj).slice(0, 300)}`);
  }
  return cj.data;
}

function emitAck(
  socket: Socket,
  event: string,
  payload: unknown
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (ack: unknown) =>
      resolve((ack ?? {}) as Record<string, unknown>)
    );
    setTimeout(() => resolve({ timeout: true }), 15_000);
  });
}

async function main(): Promise<void> {
  const before = rowOf(await mine("now"));
  check("the community is listed before the sequence starts", !!before);

  const sender: Socket = io(`${GW}/community`, {
    transports: ["websocket"],
    auth: { token: tokenA },
    forceNew: true,
  });
  const receiverFrames: { event: string; data: Record<string, unknown> }[] = [];
  const receiver: Socket = io(`${GW}/community`, {
    transports: ["websocket"],
    auth: { token: tokenB },
    forceNew: true,
  });
  receiver.onAny((event: string, data: unknown) =>
    receiverFrames.push({ event, data: (data ?? {}) as Record<string, unknown> })
  );
  await Promise.all(
    [sender, receiver].map(
      (s) =>
        new Promise<void>((resolve, reject) => {
          s.once("connect", () => resolve());
          s.once("connect_error", (e: Error) => reject(e));
          setTimeout(() => reject(new Error("connect timeout")), 10_000);
        })
    )
  );
  await sleep(400);

  // ── media ────────────────────────────────────────────────────────────────
  const file = await uploadPng();
  const mediaAck = await emitAck(sender, "community:message:send", {
    communityId: COMMUNITY,
    contentType: "IMAGE",
    message: "",
    files: [file],
    clientMessageId: `probe-mt-img-${Date.now()}`,
  });
  check("media send acked", mediaAck.success === true, JSON.stringify(mediaAck).slice(0, 160));
  await sleep(1800);

  const afterMedia = rowOf(await mine("now"));
  check("community still listed after the media send", !!afterMedia);
  check(
    "lastActivity is the photo",
    afterMedia?.lastActivity?.preview === "📷 Photo",
    afterMedia?.lastActivity?.preview ?? "none"
  );

  // ── text, immediately behind it ──────────────────────────────────────────
  const text = `probe text after media ${new Date().toISOString()}`;
  const textAck = await emitAck(sender, "community:message:send", {
    communityId: COMMUNITY,
    contentType: "TEXT",
    message: text,
    clientMessageId: `probe-mt-txt-${Date.now()}`,
  });
  check("text send acked", textAck.success === true, JSON.stringify(textAck).slice(0, 160));
  await sleep(1800);

  const afterText = rowOf(await mine("now"));
  check("community still listed after the text send", !!afterText);
  check(
    "lastActivity moved on to the text",
    afterText?.lastActivity?.preview === text,
    afterText?.lastActivity?.preview ?? "none"
  );

  // ── realtime vs reload ───────────────────────────────────────────────────
  const bump = [...receiverFrames]
    .reverse()
    .find(
      (f) => f.event === "community:updated" && f.data.communityId === COMMUNITY
    );
  const bumpPreview = (bump?.data.lastMessage as { text?: string } | undefined)?.text;
  check(
    "the receiver's realtime bump carries the same preview the reload does",
    bumpPreview === afterText?.lastActivity?.preview,
    `realtime=${JSON.stringify(bumpPreview)} reload=${JSON.stringify(afterText?.lastActivity?.preview)}`
  );
  check(
    "the receiver's realtime bump carries the same timestamp the reload does",
    Number(bump?.data.lastMessageAt) === afterText?.lastActivityAt,
    `realtime=${String(bump?.data.lastMessageAt)} reload=${String(afterText?.lastActivityAt)}`
  );
  check(
    "the row appears exactly once",
    (await mine("now")).filter((r) => r.id === COMMUNITY).length === 1
  );

  // ── the bug this endpoint used to have ───────────────────────────────────
  const skewed = rowOf(await mine(String(Date.now() - 5000)));
  console.log(
    skewed
      ? "   (a 5s-behind epoch-ms cursor still lists it — the activity is older than the skew)"
      : "   a 5s-behind epoch-ms cursor drops it: that is the clock a client must NOT send"
  );

  sender.close();
  receiver.close();
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
