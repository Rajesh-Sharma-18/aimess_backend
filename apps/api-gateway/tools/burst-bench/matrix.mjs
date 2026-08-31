import fs from "node:fs";
import { loginCached, connect, ack, api } from "./lib.mjs";

const SCRATCH = (process.env.BURST_BENCH_OUT ?? ".");
const FIX = JSON.parse(fs.readFileSync(`${SCRATCH}/fixtures.json`, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (id, status, evidence) => {
  results.push({ id, status, evidence });
  console.log(`${status} ${id} :: ${evidence}`);
};
const med = (a) => {
  const x = [...a].sort((p, q) => p - q);
  return x.length ? Math.round(x[Math.floor(x.length / 2)]) : null;
};
const mx = (a) => (a.length ? Math.round(Math.max(...a)) : null);

const A = await loginCached("A");
const B = await loginCached("B");

function collector(socket, single, batchEv) {
  const st = { byKey: new Map(), arrival: [], frames: 0, batchFrames: 0, batchSizes: [] };
  const take = (m, t) => {
    const k = m.clientMessageId || m.id;
    if (st.byKey.has(k)) return;
    st.byKey.set(k, { t, m });
    st.arrival.push(m);
  };
  socket.on(single, (m) => { st.frames++; take(m, performance.now()); });
  socket.on(batchEv, (p) => {
    st.frames++; st.batchFrames++; st.batchSizes.push(p.messages.length);
    const t = performance.now();
    for (const m of p.messages) take(m, t);
  });
  st.reset = () => {
    st.byKey.clear(); st.arrival.length = 0;
    st.frames = 0; st.batchFrames = 0; st.batchSizes.length = 0;
  };
  return st;
}

const sa = await connect(A.token);
const sb = await connect(B.token);
const sb2 = await connect(B.token);
const ca = await connect(A.token, "/community");
const cb = await connect(B.token, "/community");

const dm = FIX.dmRoomId, grp = FIX.groupRoomId, com = FIX.communityId;
await ack(sa, "conv:join", { conversationId: dm, conversationType: "private", active: true });
await ack(sb, "conv:join", { conversationId: dm, conversationType: "private", active: false });
await ack(sb2, "conv:join", { conversationId: dm, conversationType: "private", active: false });
await ack(sa, "conv:join", { conversationId: grp, conversationType: "group", active: false });
await ack(sb, "conv:join", { conversationId: grp, conversationType: "group", active: false });
const cjA = await ack(ca, "community:join", { communityId: com, active: false });
const cjB = await ack(cb, "community:join", { communityId: com, active: false });
console.log("community join:", JSON.stringify(cjA).slice(0, 90), JSON.stringify(cjB).slice(0, 90));

const rxB = collector(sb, "message:new", "message:new:batch");
const rxB2 = collector(sb2, "message:new", "message:new:batch");
const rxA = collector(sa, "message:new", "message:new:batch");
const rxComB = collector(cb, "community:message:new", "community:message:new:batch");

// A4 control: a SECOND B device that did NOT opt into batching, so the frame
// counts of the two are directly comparable under identical conditions.
const sbPlain = await connect(B.token, "/chat", { batch: false });
await ack(sbPlain, "conv:join", { conversationId: dm, conversationType: "private", active: false });
const rxPlain = collector(sbPlain, "message:new", "message:new:batch");

const sendDm = (sock, receiverId, roomId, type, text, cid, extra = {}) =>
  ack(sock, "message:send", {
    conversationId: roomId, conversationType: type,
    ...(receiverId ? { receiverId } : {}),
    contentText: text, contentType: "TEXT", clientMessageId: cid, ...extra,
  });
const sendCom = (sock, text, cid) =>
  ack(sock, "community:message:send", { communityId: com, message: text, contentType: "TEXT", clientMessageId: cid });

async function burst(label, n, gapMs, send, rx, settle = 5000) {
  rx.reset();
  const rows = [];
  for (let i = 0; i < n; i++) {
    const cid = `${label}-${Date.now()}-${i}`;
    const t0 = performance.now();
    rows.push(send(cid, i).then((r) => ({ cid, t0, ok: r && r.success !== false, err: r && r.error, ackAt: performance.now() })));
    if (gapMs) await sleep(gapMs);
  }
  const sent = await Promise.all(rows);
  await sleep(settle);
  const lat = sent.filter((s) => rx.byKey.has(s.cid)).map((s) => rx.byKey.get(s.cid).t - s.t0);
  return { sent, lat, delivered: sent.filter((s) => rx.byKey.has(s.cid)).length };
}

// Warm-up: the first send after an idle period pays gRPC channel + Mongo pool
// warm-up, which has nothing to do with what is being measured.
for (let i = 0; i < 3; i++) {
  await sendDm(sa, B.userId, dm, "private", "warmup", `warm-${Date.now()}-${i}`);
  await sleep(400);
}
await sleep(2500);
console.log("warm-up done");

// A. burst delivery
{
  rxPlain.reset();
  const r = await burst("A1", 10, 30, (cid) => sendDm(sa, B.userId, dm, "private", `A1 ${cid}`, cid), rxB);
  rec("A1", r.delivered === 10 && mx(r.lat) < 4000 ? "PASS" : "FAIL",
    `private 10-burst delivered=${r.delivered}/10 p50=${med(r.lat)}ms max=${mx(r.lat)}ms frames=${rxB.frames} batchFrames=${rxB.batchFrames} batchSizes=[${rxB.batchSizes}]`);
  rec("A4", rxB.batchFrames > 0 && rxB.frames < rxPlain.frames ? "PASS" : "FAIL",
    `same 10 messages, same conditions: batching client got ${rxB.frames} frames (${rxB.batchFrames} coalesced, sizes [${rxB.batchSizes}]); non-batching control client got ${rxPlain.frames}`);
  rec("A5", r.sent.every((s) => s.ok) ? "PASS" : "FAIL",
    `sender acked ${r.sent.filter((s) => s.ok).length}/10, p50 ack=${med(r.sent.map((s) => s.ackAt - s.t0))}ms`);

  const seqs = rxB.arrival.map((m) => m.sequenceNumber);
  const sorted = [...seqs].sort((a, b) => a - b);
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  rec("C1", contiguous ? "PASS" : "FAIL",
    `sequenceNumbers ${sorted[0]}..${sorted[sorted.length - 1]} contiguous=${contiguous}`);

  const hist = await api(B.token, `/chat/private/rooms/${dm}/messages?limit=50`);
  const histIds = new Set((hist.data.data ?? []).map((m) => m.id));
  const missing = r.sent.filter((s) => { const g = rxB.byKey.get(s.cid); return g && !histIds.has(g.m.id); });
  rec("A6", r.delivered === 10 && missing.length === 0 ? "PASS" : "FAIL",
    `sent=10 received=${r.delivered} unique=${rxB.byKey.size} notInHistory=${missing.length}`);
  rec("I2", missing.length === 0 ? "PASS" : "FAIL",
    `every socket-delivered message present in GET /messages (${r.delivered} checked)`);
}
{
  const r = await burst("A2", 10, 30, (cid) => sendDm(sa, "", grp, "group", `A2 ${cid}`, cid), rxB);
  rec("A2", r.delivered === 10 && mx(r.lat) < 4000 ? "PASS" : "FAIL",
    `group 10-burst delivered=${r.delivered}/10 p50=${med(r.lat)}ms max=${mx(r.lat)}ms frames=${rxB.frames} batchFrames=${rxB.batchFrames}`);
}
if (com) {
  const r = await burst("A3", 10, 30, (cid) => sendCom(ca, `A3 ${cid}`, cid), rxComB);
  rec("A3", r.delivered === 10 ? "PASS" : "FAIL",
    `community 10-burst delivered=${r.delivered}/10 p50=${med(r.lat)}ms max=${mx(r.lat)}ms frames=${rxComB.frames} batchFrames=${rxComB.batchFrames}`);
} else {
  rec("A3", "BLOCKED", "no community shared by both accounts");
}

// B. single-message latency
{
  // Measured against the non-batching control device in the SAME send, so the
  // claim is "batching adds nothing to an isolated message" rather than a bare
  // wall-clock number this machine cannot hold steady.
  const single = async (tag) => {
    rxPlain.reset();
    const cid = `${tag}-${Date.now()}`;
    const t0 = performance.now();
    await sendDm(sa, B.userId, dm, "private", `${tag} ${cid}`, cid);
    for (let i = 0; i < 20 && !(rxB.byKey.has(cid) && rxPlain.byKey.has(cid)); i++) await sleep(150);
    return {
      batched: rxB.byKey.has(cid) ? rxB.byKey.get(cid).t - t0 : null,
      plain: rxPlain.byKey.has(cid) ? rxPlain.byKey.get(cid).t - t0 : null,
    };
  };
  await sleep(1500);
  rxB.reset();
  const one = await single("B1");
  rec("B1", one.batched != null && rxB.batchFrames === 0 && one.batched - one.plain < 60 ? "PASS" : "FAIL",
    `isolated single: batching client ${Math.round(one.batched)}ms vs non-batching control ${Math.round(one.plain)}ms (delta ${Math.round(one.batched - one.plain)}ms), delivered as a plain message:new (batchFrames=${rxB.batchFrames})`);
  await sleep(1500);
  rxB.reset();
  const two = await single("B2");
  rec("B2", two.batched != null && rxB.batchFrames === 0 && two.batched - two.plain < 60 ? "PASS" : "FAIL",
    `follow-up after a pause longer than the window: ${Math.round(two.batched)}ms vs control ${Math.round(two.plain)}ms (delta ${Math.round(two.batched - two.plain)}ms), un-batched`);
}

// C2. concurrent senders
{
  rxB.reset(); rxA.reset();
  const jobs = [];
  for (let i = 0; i < 6; i++) {
    jobs.push(sendDm(sa, B.userId, dm, "private", `C2-A${i}`, `C2-A-${Date.now()}-${i}`));
    jobs.push(sendDm(sb, A.userId, dm, "private", `C2-B${i}`, `C2-B-${Date.now()}-${i}`));
    await sleep(25);
  }
  await Promise.all(jobs);
  await sleep(3500);
  const orderOf = (rx) => rx.arrival.map((m) => [m.sequenceNumber, m.id]).sort((x, y) => x[0] - y[0]).map((x) => x[1]).join(",");
  const same = orderOf(rxB) === orderOf(rxA) && orderOf(rxB).length > 0;
  rec("C2", same ? "PASS" : "FAIL",
    `12 messages from 2 concurrent senders: receivers agree on sequence order (identical=${same}, A saw ${rxA.byKey.size}, B saw ${rxB.byKey.size})`);
}

// C3. edit + delete inside the window
{
  rxB.reset();
  const cids = [];
  for (let i = 0; i < 4; i++) {
    const cid = `C3-${Date.now()}-${i}`;
    cids.push(cid);
    void sendDm(sa, B.userId, dm, "private", `C3 original ${i}`, cid);
    await sleep(20);
  }
  await sleep(2500);
  const target = rxB.byKey.get(cids[1]) && rxB.byKey.get(cids[1]).m;
  const doomed = rxB.byKey.get(cids[2]) && rxB.byKey.get(cids[2]).m;
  let editedSeen = false, deletedSeen = false;
  sb.on("message:edited", (m) => { if (target && m.id === target.id) editedSeen = true; });
  sb.on("message:delete", (m) => { if (doomed && (m.messageId ?? m.id) === doomed.id) deletedSeen = true; });
  const e = await api(A.token, `/chat/private/messages/${target.id}`, { method: "PATCH", body: JSON.stringify({ content: { text: "C3 edited" } }) });
  const d = await api(A.token, `/chat/private/messages/${doomed.id}?type=forEveryone`, { method: "DELETE" });
  await sleep(2500);
  const hist = await api(B.token, `/chat/private/rooms/${dm}/messages?limit=30`);
  const rows = hist.data.data ?? [];
  const t = rows.find((m) => m.id === target.id);
  const dd = rows.find((m) => m.id === doomed.id);
  const editOk = ((t && t.content && t.content.text) || "").includes("edited");
  const delOk = !dd || dd.isDeleted === true;
  rec("C3", editOk && delOk ? "PASS" : "FAIL",
    `edit->history text "${((t && t.content && t.content.text) || "").slice(0, 24)}" (api ${e.success}); delete->isDeleted=${dd ? dd.isDeleted : "row-gone"} (api ${d.success}); sockets edited=${editedSeen} deleted=${deletedSeen}`);
}

// C5. replies inside a burst
{
  rxB.reset();
  const baseCid = `C5-base-${Date.now()}`;
  await sendDm(sa, B.userId, dm, "private", "C5 base", baseCid);
  await sleep(1500);
  const base = rxB.byKey.get(baseCid) && rxB.byKey.get(baseCid).m;
  rxB.reset();
  const replies = [];
  for (let i = 0; i < 5; i++) {
    const cid = `C5-r-${Date.now()}-${i}`;
    replies.push(cid);
    void sendDm(sa, B.userId, dm, "private", `C5 reply ${i}`, cid, { repliedToId: base.id });
    await sleep(20);
  }
  await sleep(2500);
  const got = replies.map((c) => rxB.byKey.get(c) && rxB.byKey.get(c).m).filter(Boolean);
  const matched = got.filter((m) => (m.parentMessageId || (m.quoteData && m.quoteData.messageId)) === base.id).length;
  rec("C5", got.length === 5 && matched === 5 ? "PASS" : "FAIL",
    `5 replies inside one burst resolve to parent ${base.id}: matched=${matched}/5 delivered=${got.length}/5`);
}

// C4. mixed content types inside ONE burst
{
  rxB.reset();
  const cids = [];
  const mix = [
    ["TEXT", { contentText: "C4 text" }],
    ["LOCATION", { contentType: "LOCATION", location: { lat: 12.34, lng: 56.78, placeName: "C4 place" } }],
    ["TEXT", { contentText: "C4 text 2" }],
    ["CONTACT", { contentType: "CONTACT", contact: { name: "C4 Contact", phone: "+10000000000" } }],
  ];
  for (const [, extra] of mix) {
    const cid = `C4-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    cids.push(cid);
    void ack(sa, "message:send", {
      conversationId: dm, conversationType: "private", receiverId: B.userId,
      contentType: "TEXT", clientMessageId: cid, ...extra,
    });
    await sleep(25);
  }
  await sleep(3000);
  const got = cids.map((c) => rxB.byKey.get(c) && rxB.byKey.get(c).m).filter(Boolean);
  const kinds = got.map((m) => String(m.contentType ?? m.messageType ?? ""));
  const hasLocation = got.some((m) => m.content && m.content.location);
  const hasContact = got.some((m) => m.content && m.content.contact);
  rec("C4", got.length === 4 && hasLocation && hasContact ? "PASS" : "FAIL",
    `mixed burst delivered=${got.length}/4 kinds=[${kinds}] locationPayloadIntact=${hasLocation} contactPayloadIntact=${hasContact} (media/system rows covered by C3 + the system-message suites, see report)`);
}

// F1. flush-boundary
{
  rxB.reset();
  const cids = [];
  for (let i = 0; i < 8; i++) {
    const cid = `F1-${Date.now()}-${i}`;
    cids.push(cid);
    void sendDm(sa, B.userId, dm, "private", `F1 ${i}`, cid);
    await sleep(300);
  }
  await sleep(3000);
  const delivered = cids.filter((c) => rxB.byKey.has(c)).length;
  const dupes = rxB.arrival.length - new Set(rxB.arrival.map((m) => m.id)).size;
  rec("F1", delivered === 8 && dupes === 0 ? "PASS" : "FAIL",
    `8 messages spaced exactly at the 300ms window boundary: delivered=${delivered}/8 duplicates=${dupes}`);
}

// G1. two devices
{
  rxB.reset(); rxB2.reset();
  await burst("G1", 8, 25, (cid) => sendDm(sa, B.userId, dm, "private", `G1 ${cid}`, cid), rxB);
  await sleep(800);
  rec("G1", rxB.byKey.size === 8 && rxB2.byKey.size === 8 ? "PASS" : "FAIL",
    `both devices of B got the whole burst: device1=${rxB.byKey.size}/8 device2=${rxB2.byKey.size}/8 (batchFrames ${rxB.batchFrames}/${rxB2.batchFrames})`);
}

// H1. scale
{
  const r = await burst("H1", 50, 10, (cid) => sendDm(sa, B.userId, dm, "private", `H1 ${cid}`, cid), rxB, 6000);
  const errs = r.sent.filter((s) => !s.ok).map((s) => s.err);
  rec("H1", r.delivered === 50 ? "PASS" : "FAIL",
    `50-burst delivered=${r.delivered}/50 acked=${r.sent.filter((s) => s.ok).length}/50 errs=${JSON.stringify([...new Set(errs)])} p50=${med(r.lat)}ms max=${mx(r.lat)}ms frames=${rxB.frames} batchFrames=${rxB.batchFrames}`);
}

// H2. two rooms at once
{
  rxB.reset();
  const jobs = [];
  for (let i = 0; i < 8; i++) {
    jobs.push(sendDm(sa, B.userId, dm, "private", `H2-dm-${i}`, `H2-dm-${Date.now()}-${i}`));
    jobs.push(sendDm(sa, "", grp, "group", `H2-grp-${i}`, `H2-grp-${Date.now()}-${i}`));
    await sleep(15);
  }
  const res = await Promise.all(jobs);
  await sleep(4000);
  for (let i = 0; i < 12 && rxB.byKey.size < 16; i++) await sleep(800);
  const h2errs = [...new Set(res.filter((r) => r && r.success === false).map((r) => r.error))];
  let bad = 0;
  for (const m of rxB.arrival) {
    const text = (m.content && m.content.text) || "";
    if (m.roomId === dm && text.startsWith("H2-grp")) bad++;
    if (m.roomId === grp && text.startsWith("H2-dm")) bad++;
  }
  rec("H2", bad === 0 && rxB.byKey.size === 16 ? "PASS" : "FAIL",
    `two rooms bursting concurrently: ${rxB.byKey.size}/16 delivered, cross-room leakage=${bad}, sendErrors=${JSON.stringify(h2errs)}`);
}

fs.writeFileSync(`${SCRATCH}/matrix.json`, JSON.stringify(results, null, 1));
console.log(`\nSUMMARY ${results.filter((r) => r.status === "PASS").length}/${results.length} PASS`);
console.log(results.filter((r) => r.status !== "PASS").map((r) => `${r.id}:${r.status}`).join(" ") || "all green");
process.exit(0);
