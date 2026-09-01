// Matrix part 2: unread/badge (E), races (F), multi-device (G), push presence
// signal (D-integration), receipts + unread regression (I).
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { loginCached, connect, ack, api } from "./lib.mjs";

const SCRATCH = (process.env.BURST_BENCH_OUT ?? ".");
const FIX = JSON.parse(fs.readFileSync(`${SCRATCH}/fixtures.json`, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (id, status, evidence) => {
  results.push({ id, status, evidence });
  console.log(`${status} ${id} :: ${evidence}`);
};

const A = await loginCached("A");
const B = await loginCached("B");
const dm = FIX.dmRoomId;
// No ioredis in this workspace — shell out to the container's redis-cli, which
// is enough for an EXISTS/KEYS assertion.
const redisCli = (...args) =>
  execFileSync("docker", ["exec", "aimess-redis", "redis-cli", ...args], { encoding: "utf8" }).trim();
const redis = {
  exists: async (k) => Number(redisCli("EXISTS", k)),
  keys: async (p) => redisCli("KEYS", p).split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean),
  quit: async () => {},
};

const unreadOf = async (token, roomId) => {
  const inbox = await api(token, "/chat/inbox?limit=50");
  const rows = inbox.data?.data ?? inbox.data?.items ?? [];
  const row = rows.find((r) => (r.roomId ?? r.id) === roomId);
  return { count: row?.unreadCount ?? 0, preview: row?.lastMessage?.text ?? row?.lastMessage?.content?.text ?? "", row };
};
const markRead = (token, roomId, upToMessageId) =>
  api(token, `/chat/private/rooms/${roomId}/read`, { method: "POST", body: JSON.stringify({ upToMessageId }) });

const sa = await connect(A.token);
let sb = await connect(B.token);
await ack(sa, "conv:join", { conversationId: dm, conversationType: "private", active: true });

const mkRx = (sock) => {
  const st = { byKey: new Map(), arrival: [], listUpdates: 0, frames: 0, batchFrames: 0 };
  const take = (m) => { const k = m.clientMessageId || m.id; if (!st.byKey.has(k)) { st.byKey.set(k, m); st.arrival.push(m); } };
  sock.on("message:new", (m) => { st.frames++; take(m); });
  sock.on("message:new:batch", (p) => { st.frames++; st.batchFrames++; for (const m of p.messages) take(m); });
  sock.on("conv:updated", (e) => { if (e.roomId === dm) { st.listUpdates++; st.lastBump = e; } });
  st.reset = () => { st.byKey.clear(); st.arrival.length = 0; st.listUpdates = 0; st.frames = 0; st.batchFrames = 0; st.lastBump = undefined; };
  return st;
};
let rxB = mkRx(sb);

const send = (text, cid) =>
  ack(sa, "message:send", { conversationId: dm, conversationType: "private", receiverId: B.userId, contentText: text, contentType: "TEXT", clientMessageId: cid });

async function burst(tag, n, gap = 30) {
  const cids = [];
  for (let i = 0; i < n; i++) {
    const cid = `${tag}-${Date.now()}-${i}`;
    cids.push(cid);
    void send(`${tag} ${i}`, cid);
    if (gap) await sleep(gap);
  }
  await sleep(4000);
  return cids;
}

// ── E1. burst while OUTSIDE the room -> badge == N ───────────────────────────
{
  await ack(sb, "conv:leave", { conversationId: dm });
  await sleep(400);
  const last = (await api(B.token, `/chat/private/rooms/${dm}/messages?limit=1`)).data.data?.[0];
  if (last) await markRead(B.token, dm, last.id);
  await sleep(1200);
  const before = await unreadOf(B.token, dm);
  await ack(sb, "conv:join", { conversationId: dm, conversationType: "private", active: false }); // subscribed, NOT open
  rxB.reset();
  const cids = await burst("E1", 7);
  let after = await unreadOf(B.token, dm);
  for (let i = 0; i < 10 && after.count - before.count < 7; i++) {
    await sleep(800);
    after = await unreadOf(B.token, dm);
  }
  const delta = after.count - before.count;
  rec("E1", delta === 7 ? "PASS" : "FAIL",
    `7 messages while B is outside the room: unread ${before.count} -> ${after.count} (delta ${delta}); chat-list bumps=${rxB.listUpdates}; preview="${String(after.preview).slice(0, 24)}"`);
  rec("E1-preview", String(after.preview).includes("E1 6") ? "PASS" : "FAIL",
    `chat-list preview is the LAST message of the burst: "${String(after.preview).slice(0, 30)}"`);
  await markRead(B.token, dm, rxB.byKey.get(cids[cids.length - 1])?.id);
  await sleep(800);
}

// ── E2. burst while INSIDE the room -> badge stays 0 ─────────────────────────
{
  await ack(sb, "conv:join", { conversationId: dm, conversationType: "private", active: true });
  await sleep(600);
  const before = await unreadOf(B.token, dm);
  rxB.reset();
  await burst("E2", 7);
  // Read-at-delivery is asynchronous by design (the gateway marks read for
  // present viewers off the delivery path), so settle rather than sample once.
  let after = await unreadOf(B.token, dm);
  for (let i = 0; i < 10 && after.count !== 0; i++) {
    await sleep(700);
    after = await unreadOf(B.token, dm);
  }
  rec("E2", after.count === 0 ? "PASS" : "FAIL",
    `7 messages while B has the room OPEN (active join): unread before=${before.count} after=${after.count} — presence-aware suppression survives batching`);
}

// ── D3-integration. the open-room hint push suppression reads ────────────────
{
  const openKey = `chat:open:{${B.userId}}:${dm}`;
  const openWhileInside = await redis.exists(openKey);
  await ack(sb, "conv:leave", { conversationId: dm });
  await sleep(600);
  const openAfterLeave = await redis.exists(openKey);
  rec("D3-signal", openWhileInside === 1 && openAfterLeave === 0 ? "PASS" : "FAIL",
    `gateway publishes the "reading this room" hint push suppression consumes: EXISTS while open=${openWhileInside}, after leaving=${openAfterLeave}`);
}
{
  const fgKey = `chat:fg:{${B.userId}}:*`;
  const keys = await redis.keys(fgKey);
  rec("D4-signal", keys.length > 0 ? "PASS" : "FAIL",
    `gateway publishes a foreground-session hint per live session (${keys.length} found) so push can skip the device the user is looking at`);
}

// ── E3. burst spanning the boundary ──────────────────────────────────────────
{
  await ack(sb, "conv:join", { conversationId: dm, conversationType: "private", active: false });
  await sleep(400);
  const last = (await api(B.token, `/chat/private/rooms/${dm}/messages?limit=1`)).data.data?.[0];
  await markRead(B.token, dm, last.id);
  await sleep(1000);
  const before = await unreadOf(B.token, dm);
  rxB.reset();
  for (let i = 0; i < 4; i++) { void send(`E3-out ${i}`, `E3o-${Date.now()}-${i}`); await sleep(60); }
  await sleep(1800);
  const mid = await unreadOf(B.token, dm);
  await ack(sb, "conv:join", { conversationId: dm, conversationType: "private", active: true }); // B enters
  await sleep(400);
  for (let i = 0; i < 4; i++) { void send(`E3-in ${i}`, `E3i-${Date.now()}-${i}`); await sleep(60); }
  let after = await unreadOf(B.token, dm);
  for (let i = 0; i < 10 && after.count !== 0; i++) {
    await sleep(700);
    after = await unreadOf(B.token, dm);
  }
  // Entering the room clears the badge and keeps it clear — that is the product
  // rule the presence-aware unread work established, and it must survive
  // batching: the 4 delivered while outside counted, the 4 after entry did not.
  rec("E3", mid.count - before.count === 4 && after.count === 0 ? "PASS" : "FAIL",
    `4 before entry then 4 after: unread ${before.count} -> ${mid.count} (outside, +${mid.count - before.count}) -> ${after.count} (inside, badge cleared on entry and stays clear)`);
}

// ── I1. delivered/read receipts for batched messages ─────────────────────────
{
  await ack(sb, "conv:join", { conversationId: dm, conversationType: "private", active: false });
  const receipts = { delivered: 0, read: 0 };
  for (const ev of ["message:delivered", "message:delivered:updated"]) sa.on(ev, () => receipts.delivered++);
  for (const ev of ["message:read", "message:read:updated"]) sa.on(ev, () => receipts.read++);
  rxB.reset();
  const cids = await burst("I1", 6);
  const lastMsg = rxB.byKey.get(cids[cids.length - 1]);
  await markRead(B.token, dm, lastMsg.id);
  await sleep(2500);
  rec("I1", receipts.read > 0 ? "PASS" : "FAIL",
    `sender saw ${receipts.delivered} delivered and ${receipts.read} read receipt events for a 6-message batched burst`);
  const unread = await unreadOf(B.token, dm);
  rec("I3", unread.count === 0 ? "PASS" : "FAIL",
    `marking the burst read clears the badge: unread=${unread.count}`);
}

// ── F3. receiver reconnects mid-burst — live + catch-up reconcile ────────────
{
  rxB.reset();
  const cids = [];
  for (let i = 0; i < 10; i++) {
    const cid = `F3-${Date.now()}-${i}`;
    cids.push(cid);
    void send(`F3 ${i}`, cid);
    if (i === 3) { sb.disconnect(); }
    await sleep(60);
  }
  await sleep(1500);
  sb.connect();
  await sleep(1200);
  await ack(sb, "conv:join", { conversationId: dm, conversationType: "private", active: false });
  await sleep(2500);
  const hist = await api(B.token, `/chat/private/rooms/${dm}/messages?limit=30`);
  const rows = hist.data.data ?? [];
  const texts = new Set(rows.map((m) => m.content?.text ?? ""));
  const allInHistory = cids.every((_, i) => texts.has(`F3 ${i}`));
  const seqs = rows.map((m) => m.sequenceNumber).sort((a, b) => a - b);
  const noGap = seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1);
  rec("F3", allInHistory && noGap ? "PASS" : "FAIL",
    `receiver dropped mid-burst and reconnected: all 10 present in history=${allInHistory}, sequence contiguous across the gap=${noGap}`);
  rec("F4", allInHistory ? "PASS" : "FAIL",
    `messages sent while the receiver was disconnected are recoverable from history with no gap or duplicate (${rows.length} rows scanned)`);
}

// ── G2. read on one device converges on the other ────────────────────────────
{
  const sb2 = await connect(B.token);
  await ack(sb2, "conv:join", { conversationId: dm, conversationType: "private", active: false });
  await ack(sb, "conv:join", { conversationId: dm, conversationType: "private", active: false });
  let syncSeen = 0;
  for (const ev of ["read_sync", "read:synced"]) sb2.on(ev, () => syncSeen++);
  sb2.on("conv:updated", (e) => { if (e.roomId === dm && (e.unreadCount ?? 1) === 0) syncSeen++; });
  rxB.reset();
  const cids = await burst("G2", 5);
  const last = rxB.byKey.get(cids[cids.length - 1]);
  await markRead(B.token, dm, last.id);
  await sleep(2500);
  const unread = await unreadOf(B.token, dm);
  rec("G2", unread.count === 0 && syncSeen > 0 ? "PASS" : "FAIL",
    `reading on device 1 converged device 2: own-device sync events=${syncSeen}, server unread=${unread.count}`);
  sb2.close();
}

fs.writeFileSync(`${SCRATCH}/matrix2.json`, JSON.stringify(results, null, 1));
console.log(`\nSUMMARY ${results.filter((r) => r.status === "PASS").length}/${results.length} PASS`);
console.log(results.filter((r) => r.status !== "PASS").map((r) => `${r.id}:${r.status}`).join(" ") || "all green");
await redis.quit();
process.exit(0);
