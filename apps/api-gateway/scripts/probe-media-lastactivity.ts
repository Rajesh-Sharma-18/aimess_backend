/**
 * Live probe: does a MEDIA send bump the RECEIVER's conversation-list row in
 * real time when the sender is a client that does NOT put `receiverId` on the
 * wire (every mobile client), and does that bump match the one the REST /
 * website paths produce?
 *
 * Drives the real stack over Socket.IO and REST exactly like a client does, and
 * records every frame each participant receives. Covers private / group /
 * community, every media content type, albums, replies, forwards, an open vs a
 * closed room, a second receiver session and a second SENDER session, and
 * compares the live row against the REST inbox (realtime == reload).
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> ROOM=prv_xxx GROUP=grp_xxx COMMUNITY=<id> \
 *   USER_A=<sender uuid> USER_B=<receiver uuid> \
 *   pnpm exec tsx scripts/probe-media-lastactivity.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const REST = process.env.GATEWAY_HTTP ?? "http://localhost:3000";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const ROOM = process.env.ROOM ?? "";
const GROUP = process.env.GROUP ?? "";
const COMMUNITY = process.env.COMMUNITY ?? "";
const A = process.env.USER_A ?? "";
const B = process.env.USER_B ?? "";

if (!SECRET || !ROOM || !A || !B) {
  console.error("ROOM, USER_A, USER_B and JWT_ACCESS_SECRET are required.");
  process.exit(2);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
}

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

interface Client {
  label: string;
  socket: Socket;
  frames: Frame[];
}

function token(userId: string): string {
  return signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 3600,
  });
}

async function connect(
  label: string,
  userId: string,
  namespace: "chat" | "community" = "chat"
): Promise<Client> {
  const frames: Frame[] = [];
  const socket: Socket = io(`${GW}/${namespace}`, {
    transports: ["websocket"],
    auth: { token: token(userId) },
    forceNew: true,
  });
  socket.onAny((event: string, data: unknown) => {
    frames.push({ event, data: (data ?? {}) as Record<string, unknown> });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (e: Error) => reject(e));
    setTimeout(() => reject(new Error(`${label} connect timeout`)), 10000);
  });
  return { label, socket, frames };
}

function emitAck(socket: Socket, event: string, payload: unknown) {
  return new Promise<Record<string, unknown>>((resolve) => {
    socket.emit(event, payload, (ack: unknown) =>
      resolve((ack ?? {}) as Record<string, unknown>)
    );
    setTimeout(() => resolve({ timeout: true }), 10000);
  });
}

/**
 * Real bytes per MIME. media-service runs a magic-byte check AND a deep
 * structural inspection at `/confirm`, so a PNG renamed to `.mp4` is rejected
 * before it can ever be attached — the upload has to be a genuine (if tiny)
 * instance of the type it claims.
 */
const BYTES: Record<string, Buffer> = {
  "image/png": Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  ),
  // 1x1 GIF89a.
  "image/gif": Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64"
  ),
  // 1x1 baseline JPEG.
  "image/jpeg": Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
      "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
      "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "base64"
  ),
  "application/pdf": Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 9 9]>>endobj\n" +
      "trailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1"
  ),
};

// Video and audio cannot be hand-assembled small enough to stay readable here
// AND survive the deep structural inspection, so point the probe at real files
// when you have them; without them those types are reported as SKIPPED.
for (const [mime, envVar] of [
  ["video/mp4", "PROBE_MP4"],
  ["audio/wav", "PROBE_WAV"],
] as const) {
  const path = process.env[envVar];
  if (!path) continue;
  try {
    BYTES[mime] = readFileSync(path);
  } catch {
    console.log(`   ${envVar}=${path} unreadable — ${mime} will be skipped`);
  }
}

/**
 * Real presign → PUT → confirm, so the send passes chat-service's attachment
 * guard. Returns null when media-service refuses the bytes — the caller then
 * SKIPS that type rather than reporting a product failure for a probe fixture
 * the structural inspector could not accept.
 */
async function upload(
  category: string,
  resourceId: string,
  mime = "image/png",
  name = "probe.png"
): Promise<Record<string, unknown> | null> {
  const body = BYTES[mime];
  if (!body) return null;
  const auth = {
    authorization: `Bearer ${token(A)}`,
    "content-type": "application/json",
  };
  const s1 = await fetch(`${REST}/api/v1/media/upload-url`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      category,
      contentType: mime,
      contentLength: body.length,
      resourceId,
    }),
  });
  const j1 = (await s1.json()) as {
    data?: { uploadUrl: string; objectKey: string };
  };
  if (!s1.ok || !j1.data) {
    throw new Error(`upload-url ${s1.status}: ${JSON.stringify(j1)}`);
  }
  const put = await fetch(j1.data.uploadUrl, {
    method: "PUT",
    headers: { "content-type": mime },
    body: new Uint8Array(body),
  });
  if (!put.ok) throw new Error(`PUT ${put.status}`);
  const conf = await fetch(`${REST}/api/v1/media/confirm`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      objectKey: j1.data.objectKey,
      category,
      contentType: mime,
    }),
  });
  const cj = (await conf.json()) as { data?: { scanStatus?: string } };
  const status = cj.data?.scanStatus;
  if (process.env.PROBE_VERBOSE) {
    console.log(`   upload ${mime} -> ${conf.status} ${status}`);
  }
  if (status !== "CLEAN" && status !== "SKIPPED" && status !== "PENDING") {
    return null;
  }
  return {
    objectKey: j1.data.objectKey,
    name,
    size: body.length,
    mime,
  };
}

/** Upload that must succeed — the image fixtures always do. */
async function mustUpload(
  category: string,
  resourceId: string
): Promise<Record<string, unknown>> {
  const f = await upload(category, resourceId);
  if (!f) throw new Error(`upload rejected for ${category}`);
  return f;
}

function lastBump(
  c: Client,
  event = "conv:updated"
): Record<string, unknown> | undefined {
  for (let i = c.frames.length - 1; i >= 0; i -= 1) {
    if (c.frames[i]!.event === event) return c.frames[i]!.data;
  }
  return undefined;
}

function previewOf(bump: Record<string, unknown> | undefined): string {
  const lm = bump?.lastMessage as { text?: string } | undefined;
  return lm?.text ?? "";
}

function clear(...clients: Client[]): void {
  for (const c of clients) c.frames.length = 0;
}

/** The persisted row, as a page reload would read it. */
async function inboxPreview(
  userId: string,
  roomId: string
): Promise<{ preview: string; at: number }> {
  const res = await fetch(`${REST}/api/v1/chat/inbox?limit=50`, {
    headers: { authorization: `Bearer ${token(userId)}` },
  });
  const json = (await res.json()) as {
    data?: {
      data?: Array<{
        roomId?: string;
        lastActivity?: { preview?: string };
        lastActivityAt?: number;
      }>;
    };
  };
  const row = (json.data?.data ?? []).find((r) => r.roomId === roomId);
  return {
    preview: row?.lastActivity?.preview ?? "",
    at: Number(row?.lastActivityAt ?? 0),
  };
}

/** A send shaped like a MOBILE client's: no `receiverId` on the wire. */
function mobileSend(
  socket: Socket,
  conversationId: string,
  contentType: string,
  extra: Record<string, unknown> = {}
) {
  return emitAck(socket, "message:send", {
    conversationId,
    contentType,
    contentText: "",
    clientMessageId: `probe-${contentType}-${Date.now()}-${Math.random()}`,
    conversationType: conversationId.startsWith("grp_") ? "group" : "private",
    ...extra,
  });
}

async function main() {
  const receiver = await connect("B/website", B);
  const receiver2 = await connect("B/website-2nd-session", B);
  const sender = await connect("A/mobile", A);
  const senderWeb = await connect("A/website-other-session", A);
  await sleep(400);

  // ── 1. Private: every media type, sent the way a mobile client sends ─────
  // A type whose fixture media-service refuses is SKIPPED, not failed — the
  // fan-out under test is content-type blind, and the per-type preview label is
  // pinned by tests/grpc/send-receiver-fanout.test.ts for every kind.
  const TYPES: Array<[string, string, string, string]> = [
    ["IMAGE", "📷 Photo", "image/png", "probe.png"],
    ["IMAGE", "📷 Photo", "image/jpeg", "probe.jpg"],
    ["VIDEO", "🎥 Video", "video/mp4", "probe.mp4"],
    ["GIF", "🎞 GIF", "image/gif", "probe.gif"],
    ["VOICE", "🎤 Voice Message", "audio/wav", "probe.wav"],
    ["AUDIO", "🎵 Audio", "audio/wav", "probe.wav"],
    ["DOCUMENT", "📄 report.pdf", "application/pdf", "report.pdf"],
  ];

  console.log("\n── PRIVATE · receiver has the room CLOSED ──");
  for (const [type, expected, mime, name] of TYPES) {
    const file = await upload("CHAT_ATTACHMENT", ROOM, mime, name);
    if (!file) {
      console.log(`SKIP  private ${type} (${mime}) — no usable dev fixture`);
      continue;
    }
    clear(receiver, receiver2, senderWeb);
    const sendAck = await mobileSend(sender.socket, ROOM, type, {
      files: [file],
    });
    await sleep(1200);
    if (process.env.PROBE_VERBOSE) {
      console.log(`   ack ${JSON.stringify(sendAck).slice(0, 220)}`);
    }
    const bump = lastBump(receiver);
    check(
      `private ${type} → receiver conv:updated "${expected}"`,
      previewOf(bump) === expected,
      previewOf(bump) || "no conv:updated"
    );
    check(
      `private ${type} → receiver personal message:new`,
      receiver.frames.some((f) => f.event === "message:new")
    );
    check(
      `private ${type} → receiver 2nd session updated`,
      previewOf(lastBump(receiver2)) === expected
    );
    check(
      `private ${type} → sender's other session updated`,
      previewOf(lastBump(senderWeb)) === expected
    );
    const reload = await inboxPreview(B, ROOM);
    check(
      `private ${type} → realtime == reload`,
      reload.preview === expected,
      `reload="${reload.preview}"`
    );
    check(
      `private ${type} → row timestamp advanced with the preview`,
      reload.at === Number(bump?.lastMessageAt ?? -1),
      `reload=${reload.at} bump=${String(bump?.lastMessageAt)}`
    );
  }

  // ── 2. Caption, album, reply, forward ────────────────────────────────────
  console.log("\n── PRIVATE · caption / album / reply / forward ──");
  {
    const file = await mustUpload("CHAT_ATTACHMENT", ROOM);
    clear(receiver);
    await mobileSend(sender.socket, ROOM, "IMAGE", {
      files: [file],
      contentText: "look at this",
    });
    await sleep(1200);
    check(
      "private IMAGE + caption → still the label",
      previewOf(lastBump(receiver)) === "📷 Photo",
      previewOf(lastBump(receiver))
    );
  }
  {
    const f1 = await mustUpload("CHAT_ATTACHMENT", ROOM);
    const f2 = await mustUpload("CHAT_ATTACHMENT", ROOM);
    clear(receiver);
    await mobileSend(sender.socket, ROOM, "IMAGE", { files: [f1, f2] });
    await sleep(1500);
    const bumps = receiver.frames.filter((f) => f.event === "conv:updated");
    const news = receiver.frames.filter((f) => f.event === "message:new");
    check(
      "private ALBUM(2) → exactly ONE conv:updated",
      bumps.length === 1,
      `${bumps.length}`
    );
    check(
      "private ALBUM(2) → one message:new per row",
      news.length === 2,
      `${news.length}`
    );
    check(
      "private ALBUM(2) → preview is the label",
      previewOf(lastBump(receiver)) === "📷 Photo"
    );
  }
  {
    const file = await mustUpload("CHAT_ATTACHMENT", ROOM);
    clear(receiver);
    const ack = await mobileSend(sender.socket, ROOM, "IMAGE", {
      files: [file],
    });
    const replyTargetId = String(
      (ack.data as { messageId?: string } | undefined)?.messageId ?? ""
    );
    await sleep(1000);
    const file2 = await mustUpload("CHAT_ATTACHMENT", ROOM);
    clear(receiver);
    await mobileSend(sender.socket, ROOM, "IMAGE", {
      files: [file2],
      repliedToId: replyTargetId,
    });
    await sleep(1200);
    check(
      "private REPLY with media → receiver bump",
      previewOf(lastBump(receiver)) === "📷 Photo",
      previewOf(lastBump(receiver))
    );

    clear(receiver);
    const fwdAck = await emitAck(sender.socket, "message:forward", {
      messageId: replyTargetId,
      targetConversationId: ROOM,
      conversationType: "private",
      clientMessageId: `probe-fwd-${Date.now()}`,
    });
    await sleep(1200);
    const fwdBump = lastBump(receiver);
    check(
      "private FORWARD media → receiver bump",
      previewOf(fwdBump) === "📷 Photo",
      previewOf(fwdBump) ||
        `no bump (ack=${JSON.stringify(fwdAck).slice(0, 160)})`
    );
  }

  // ── 3. Receiver sitting INSIDE the room ──────────────────────────────────
  console.log("\n── PRIVATE · receiver has the room OPEN ──");
  await emitAck(receiver.socket, "conv:join", {
    conversationId: ROOM,
    active: true,
  });
  {
    const file = await mustUpload("CHAT_ATTACHMENT", ROOM);
    clear(receiver);
    await mobileSend(sender.socket, ROOM, "IMAGE", { files: [file] });
    await sleep(1200);
    check(
      "private IMAGE (room open) → receiver bump",
      previewOf(lastBump(receiver)) === "📷 Photo",
      previewOf(lastBump(receiver))
    );
    const reload = await inboxPreview(B, ROOM);
    check(
      "private IMAGE (room open) → realtime == reload",
      reload.preview === "📷 Photo",
      reload.preview
    );
  }
  await emitAck(receiver.socket, "conv:leave", { conversationId: ROOM });

  // ── 4. Text baseline must be untouched ───────────────────────────────────
  console.log("\n── PRIVATE · text regression ──");
  {
    clear(receiver);
    await mobileSend(sender.socket, ROOM, "TEXT", { contentText: "yeah" });
    await sleep(1200);
    check(
      'private TEXT → receiver bump "yeah"',
      previewOf(lastBump(receiver)) === "yeah",
      previewOf(lastBump(receiver))
    );
  }

  // ── 5. Stale-event ordering: an older bump must not win ──────────────────
  console.log("\n── PRIVATE · ordering guards on the bump ──");
  {
    const file = await mustUpload("CHAT_ATTACHMENT", ROOM);
    clear(receiver);
    await mobileSend(sender.socket, ROOM, "TEXT", { contentText: "first" });
    await sleep(900);
    const textBump = lastBump(receiver);
    clear(receiver);
    await mobileSend(sender.socket, ROOM, "IMAGE", { files: [file] });
    await sleep(1200);
    const mediaBump = lastBump(receiver);
    const seqOf = (b?: Record<string, unknown>) =>
      Number((b?.lastMessage as { seq?: number } | undefined)?.seq ?? 0);
    const revOf = (b?: Record<string, unknown>) =>
      Number(b?.projectionRevision ?? 0);
    check(
      "media bump carries a HIGHER seq than the text before it",
      seqOf(mediaBump) > seqOf(textBump) && seqOf(textBump) > 0,
      `${seqOf(textBump)} → ${seqOf(mediaBump)}`
    );
    check(
      "media bump carries a HIGHER projectionRevision",
      revOf(mediaBump) > revOf(textBump) && revOf(textBump) > 0,
      `${revOf(textBump)} → ${revOf(mediaBump)}`
    );
    check(
      "media bump carries an absolute unreadCount",
      typeof mediaBump?.unreadCount === "number",
      String(mediaBump?.unreadCount)
    );
  }

  // ── 6. Sticker — media that lives OUTSIDE files[] ────────────────────────
  console.log("\n── PRIVATE · sticker ──");
  {
    const file = await mustUpload("CHAT_ATTACHMENT", ROOM);
    clear(receiver);
    await mobileSend(sender.socket, ROOM, "STICKER", {
      sticker: {
        objectKey: file.objectKey,
        packId: "probe-pack",
        stickerId: "probe-1",
      },
    });
    await sleep(1200);
    check(
      "private STICKER → receiver bump",
      previewOf(lastBump(receiver)) === "Sticker",
      previewOf(lastBump(receiver)) || "no conv:updated"
    );
  }

  // ── 7. Edit / delete must still recalculate the row ──────────────────────
  console.log("\n── PRIVATE · edit + delete regression ──");
  {
    clear(receiver);
    const ack = await mobileSend(sender.socket, ROOM, "TEXT", {
      contentText: "before edit",
    });
    const editable = String(
      (ack.data as { messageId?: string } | undefined)?.messageId ?? ""
    );
    await sleep(900);
    clear(receiver);
    await emitAck(sender.socket, "message:edit", {
      messageId: editable,
      conversationId: ROOM,
      contentText: "after edit",
      conversationType: "private",
    });
    await sleep(1200);
    check(
      "EDIT of the last message → row preview follows",
      previewOf(lastBump(receiver)) === "after edit",
      previewOf(lastBump(receiver)) || "no conv:updated"
    );
  }
  {
    const file = await mustUpload("CHAT_ATTACHMENT", ROOM);
    clear(receiver);
    const ack = await mobileSend(sender.socket, ROOM, "IMAGE", {
      files: [file],
    });
    const doomed = String(
      (ack.data as { messageId?: string } | undefined)?.messageId ?? ""
    );
    await sleep(1000);
    check(
      "delete setup → row is on the photo",
      previewOf(lastBump(receiver)) === "📷 Photo"
    );
    clear(receiver);
    await emitAck(sender.socket, "message:delete", {
      conversationId: ROOM,
      messageId: doomed,
      type: "forEveryone",
      conversationType: "private",
    });
    await sleep(1500);
    const recalc = lastBump(receiver);
    check(
      "DELETE FOR EVERYONE → row recalculates off the photo",
      Boolean(recalc) && previewOf(recalc) !== "📷 Photo",
      previewOf(recalc) || "no conv:updated"
    );
    const reload = await inboxPreview(B, ROOM);
    check(
      "DELETE FOR EVERYONE → realtime == reload",
      reload.preview === previewOf(recalc),
      `reload="${reload.preview}" live="${previewOf(recalc)}"`
    );
  }
  {
    const file = await mustUpload("CHAT_ATTACHMENT", ROOM);
    clear(receiver);
    const ack = await mobileSend(sender.socket, ROOM, "IMAGE", {
      files: [file],
    });
    const mine = String(
      (ack.data as { messageId?: string } | undefined)?.messageId ?? ""
    );
    await sleep(1000);
    clear(receiver);
    // The RECEIVER hides it for themselves only — their row must fall back to
    // what they can still see, and the sender's must not move at all.
    clear(senderWeb);
    await emitAck(receiver.socket, "message:delete", {
      conversationId: ROOM,
      messageId: mine,
      type: "forMe",
      conversationType: "private",
    });
    await sleep(1500);
    const mineReload = await inboxPreview(B, ROOM);
    check(
      "DELETE FOR ME → the hider's row no longer previews the photo",
      mineReload.preview !== "📷 Photo",
      mineReload.preview
    );
    const peerReload = await inboxPreview(A, ROOM);
    check(
      "DELETE FOR ME → the other participant still sees the photo",
      peerReload.preview === "📷 Photo",
      peerReload.preview
    );
  }

  // ── 8. Group ─────────────────────────────────────────────────────────────
  if (GROUP) {
    console.log("\n── GROUP ──");
    const file = await mustUpload("GROUP_CHAT_ATTACHMENT", GROUP);
    clear(receiver, receiver2, senderWeb);
    await mobileSend(sender.socket, GROUP, "IMAGE", { files: [file] });
    await sleep(1500);
    check(
      "group IMAGE → receiver bump",
      previewOf(lastBump(receiver)) === "📷 Photo",
      previewOf(lastBump(receiver))
    );
    check(
      "group IMAGE → receiver 2nd session bump",
      previewOf(lastBump(receiver2)) === "📷 Photo"
    );
    check(
      "group IMAGE → sender's other session bump",
      previewOf(lastBump(senderWeb)) === "📷 Photo"
    );
  }

  // ── 9. Community ─────────────────────────────────────────────────────────
  if (COMMUNITY) {
    console.log("\n── COMMUNITY ──");
    const cReceiver = await connect("B/community", B, "community");
    const cSender = await connect("A/community", A, "community");
    await sleep(400);
    const file = await mustUpload("COMMUNITY_CHAT_ATTACHMENT", COMMUNITY);
    clear(cReceiver);
    await emitAck(cSender.socket, "community:message:send", {
      communityId: COMMUNITY,
      contentType: "IMAGE",
      message: "",
      files: [file],
      clientMessageId: `probe-comm-${Date.now()}`,
    });
    await sleep(1500);
    const bump = lastBump(cReceiver, "community:updated");
    check(
      "community IMAGE → receiver community:updated",
      previewOf(bump) === "📷 Photo",
      previewOf(bump) || "no community:updated"
    );
    cReceiver.socket.close();
    cSender.socket.close();
  }

  for (const c of [receiver, receiver2, sender, senderWeb]) c.socket.close();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
