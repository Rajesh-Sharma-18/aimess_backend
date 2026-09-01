// Latency table: N repetitions of each scenario in one process, medians reported.
// Usage: LABEL=before node lat.mjs
import fs from "node:fs";
import { loginCached, connect, ack, api } from "./lib.mjs";

const SCRATCH = (process.env.BURST_BENCH_OUT ?? ".");
const LABEL = process.env.LABEL ?? "run";
const REPS = Number(process.env.REPS ?? 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { const x = [...a].sort((p, q) => p - q); return x.length ? Math.round(x[Math.floor(x.length / 2)]) : null; };

const A = await loginCached("A");
const B = await loginCached("B");
const rj = await api(A.token, `/chat/private/rooms/${B.userId}`);
const dm = rj.data.roomId;

const sa = await connect(A.token);
const sb = await connect(B.token);
await ack(sa, "conv:join", { conversationId: dm, conversationType: "private", active: true });
await ack(sb, "conv:join", { conversationId: dm, conversationType: "private", active: false });

// Control device of the SAME user, connected at the same time, that did NOT opt
// into batching. Both see the identical burst under identical machine load, so
// the difference between them IS the coalescing effect — machine noise cancels.
const sbPlain = await connect(B.token, "/chat", { batch: false });
await ack(sbPlain, "conv:join", { conversationId: dm, conversationType: "private", active: false });

const mk = () => ({ byKey: new Map(), frames: 0, batchFrames: 0 });
const st = mk();
const ctl = mk();
const bind = (sock, s) => {
  const take = (m, t) => { const k = m.clientMessageId || m.id; if (!s.byKey.has(k)) s.byKey.set(k, t); };
  sock.on("message:new", (m) => { s.frames++; take(m, performance.now()); });
  sock.on("message:new:batch", (p) => { s.frames++; s.batchFrames++; const t = performance.now(); for (const m of p.messages) take(m, t); });
};
bind(sb, st); bind(sbPlain, ctl);
const reset = () => { for (const s of [st, ctl]) { s.byKey.clear(); s.frames = 0; s.batchFrames = 0; } };

async function run(tag, n, gap) {
  reset();
  const rows = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const cid = `${tag}-${Date.now()}-${i}`;
    const ts = performance.now();
    rows.push(ack(sa, "message:send", { conversationId: dm, conversationType: "private", receiverId: B.userId, contentText: `${tag} ${i}`, contentType: "TEXT", clientMessageId: cid }).then(() => ({ cid, ts, ackAt: performance.now() })));
    if (gap) await sleep(gap);
  }
  const done = await Promise.all(rows);
  await sleep(Math.max(4000, n * 80));
  const latOf = (s) => done.filter((d) => s.byKey.has(d.cid)).map((d) => s.byKey.get(d.cid) - d.ts);
  const lat = latOf(st); const latC = latOf(ctl);
  const last = st.byKey.size ? Math.max(...st.byKey.values()) : NaN;
  const lastC = ctl.byKey.size ? Math.max(...ctl.byKey.values()) : NaN;
  return {
    delivered: lat.length, n,
    p50: med(lat), max: lat.length ? Math.round(Math.max(...lat)) : null,
    wall: Math.round(last - t0),
    ackP50: med(done.map((d) => d.ackAt - d.ts)),
    frames: st.frames, batchFrames: st.batchFrames,
    ctlDelivered: latC.length, ctlP50: med(latC), ctlMax: latC.length ? Math.round(Math.max(...latC)) : null,
    ctlWall: Math.round(lastC - t0), ctlFrames: ctl.frames,
  };
}

// warm-up, discarded
await run("warm", 3, 200);
await sleep(2000);

const scenarios = [
  ["single", 1, 0, 2500],
  ["burst10", 10, 30, 2500],
  ["burst10b", 10, 0, 2500],
  ["burst50", 50, 10, 3000],
];
const acc = {};
for (let rep = 0; rep < REPS; rep++) {
  for (const [tag, n, gap, cool] of scenarios) {
    const r = await run(tag, n, gap);
    (acc[tag] ??= []).push(r);
    console.log(`${LABEL} rep${rep} ${tag}`, JSON.stringify(r));
    await sleep(cool);
  }
}

const table = Object.entries(acc).map(([tag, runs]) => ({
  scenario: tag,
  delivered: `${runs.reduce((s, r) => s + r.delivered, 0)}/${runs.reduce((s, r) => s + r.n, 0)}`,
  p50RecvMs: med(runs.map((r) => r.p50)),
  maxRecvMs: med(runs.map((r) => r.max)),
  burstWallMs: med(runs.map((r) => r.wall)),
  p50AckMs: med(runs.map((r) => r.ackP50)),
  socketFrames: med(runs.map((r) => r.frames)),
  batchFrames: med(runs.map((r) => r.batchFrames)),
  ctl_p50RecvMs: med(runs.map((r) => r.ctlP50)),
  ctl_maxRecvMs: med(runs.map((r) => r.ctlMax)),
  ctl_burstWallMs: med(runs.map((r) => r.ctlWall)),
  ctl_socketFrames: med(runs.map((r) => r.ctlFrames)),
}));
console.table(table);
fs.writeFileSync(`${SCRATCH}/lat-${LABEL}.json`, JSON.stringify({ label: LABEL, reps: REPS, table, raw: acc }, null, 1));
process.exit(0);
