#!/usr/bin/env node
// AIMESS post-deploy end-to-end check. Run: `bash check.sh` or `powershell -File check.ps1` (config in .env).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";

const envFile = new URL("./.env", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const E = process.env;
const API = (E.API_ORIGIN || "https://api.ai5dev.tech").replace(/\/$/, "");
const API_V1 = `${API}/api/v1`;
const WEB = (E.WEB_ORIGIN || "https://ai5dev.tech").replace(/\/$/, "");
const MINIO = E.MINIO_ORIGIN || "https://minio.ai5dev.tech";
const STREAM_HOST = E.STREAM_HOST || "ai5stream.tech";
const HLS_BASE = E.HLS_BASE || `https://${STREAM_HOST}`;
const WHIP_BASE = E.WHIP_BASE || `https://${STREAM_HOST}/ingest`;
const TIMEOUT = Number(E.TIMEOUT_MS || 10000);
const ONLY = (E.ONLY || process.argv[2] || "").split(",").filter(Boolean);

// ── Reporting ────────────────────────────────────────────────────────────────
const results = [];
const C = { ok: "\x1b[32m", fail: "\x1b[31m", warn: "\x1b[33m", skip: "\x1b[90m", end: "\x1b[0m", b: "\x1b[1m" };
const section = (title) => console.log(`\n${C.b}── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}${C.end}`);
const want = (group) => !ONLY.length || ONLY.includes(group);

async function check(group, name, fn) {
  if (!want(group)) return false;
  const t0 = Date.now();
  let r;
  try {
    const detail = await fn();
    r = { group, name, status: detail?.warn ? "warn" : "ok", detail: detail?.warn ?? detail ?? "" };
  } catch (e) {
    r = { group, name, status: e?.skip ? "skip" : "fail", detail: e?.message ?? String(e) };
  }
  r.ms = Date.now() - t0;
  results.push(r);
  const detail = typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail);
  console.log(`${C[r.status]}${r.status.toUpperCase().padEnd(4)}${C.end} ${group.padEnd(9)} ${name.padEnd(44)} ${String(r.ms).padStart(5)}ms  ${detail.slice(0, 160)}`);
  return r.status === "ok" || r.status === "warn";
}
const skip = (why) => Object.assign(new Error(why), { skip: true });
const warn = (msg) => ({ warn: msg });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => randomUUID().toUpperCase();

// ── Transport helpers ────────────────────────────────────────────────────────
// One retry on a dropped connection: a single reset is network noise, two in a row is a real fault.
async function http(url, opts = {}) {
  try { return await httpOnce(url, opts); } catch (e) {
    if (!/ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed/.test(e.message)) throw e;
    await sleep(500);
    return httpOnce(url, opts);
  }
}

async function httpOnce(url, { method = "GET", token, body, headers = {}, raw, redirect = "follow" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method, redirect, signal: ctrl.signal,
      headers: {
        ...(body && !raw ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-lang": "en",
        ...headers,
      },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `timeout after ${TIMEOUT}ms` : `${e.cause?.code ?? e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function api(path, opts = {}) {
  const r = await http(path.startsWith("http") ? path : `${API_V1}/${path}`, opts);
  if (r.status >= 400 || r.json?.success === false) {
    const err = r.json?.error;
    throw new Error(`HTTP ${r.status} ${err?.code ?? ""} ${err?.message ?? r.json?.message ?? r.text.slice(0, 140)}`.replace(/\s+/g, " ").trim());
  }
  return r.json?.data ?? r.json;
}

function tcp(host, port) {
  return new Promise((resolve, reject) => {
    const s = tcpConnect({ host, port, timeout: TIMEOUT });
    s.once("connect", () => { s.destroy(); resolve(); });
    s.once("timeout", () => { s.destroy(); reject(new Error(`tcp ${host}:${port} timeout`)); });
    s.once("error", (e) => reject(new Error(`tcp ${host}:${port} ${e.code}`)));
  });
}

function connectNs(ns, token) {
  return new Promise((resolve, reject) => {
    const s = io(`${API}${ns}`, { path: "/socket.io/", auth: { token }, transports: ["websocket"], reconnection: false, timeout: TIMEOUT, forceNew: true }); // forceNew: A and B must never share a cached Manager
    const t = setTimeout(() => { s.close(); reject(new Error("connect timeout")); }, TIMEOUT);
    s.once("connect", () => { clearTimeout(t); resolve(s); });
    s.once("connect_error", (e) => { clearTimeout(t); s.close(); reject(new Error(`connect_error: ${e.message}`)); });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(TIMEOUT).emit(event, payload, (err, ack) => (err ? reject(new Error(`${event}: no ack in ${TIMEOUT}ms`)) : resolve(ack)));
  });
}
async function emitOk(socket, event, payload) {
  const ack = await emitAck(socket, event, payload);
  if (ack && ack.success === false) throw new Error(`${event} refused: ${ack.error ?? ""} ${ack.message ?? ""}`.trim());
  return ack?.data ?? ack;
}

function waitEvent(socket, event, match = () => true, ms = TIMEOUT) {
  let h;
  const p = new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off(event, h); reject(new Error(`no ${event} within ${ms}ms`)); }, ms);
    h = (payload) => { if (match(payload ?? {})) { clearTimeout(t); socket.off(event, h); resolve(payload); } };
    socket.on(event, h);
  });
  p.catch(() => {}); // avoid unhandled rejection when the caller stops waiting
  return p;
}

const jwtSub = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
const idOf = (o) => o?.messageId ?? o?.id ?? o?._id ?? o?.message?.id ?? o?.message?._id ?? o?.message?.messageId;
const msgObj = (p) => (p?.message && typeof p.message === "object" ? p.message : p);
const sameMsg = (clientId, serverId) => (p) => {
  const m = msgObj(p);
  return (clientId && (m?.clientMessageId ?? "").toUpperCase() === clientId) || (serverId && idOf(m) === serverId);
};
const listOf = (d) => (Array.isArray(d) ? d : d?.items ?? d?.data ?? d?.results ?? d?.streams ?? d?.messages ?? d?.rooms ?? []);

const device = (label) => ({
  deviceId: `health-check-${label}`, platform: "ANDROID", deviceType: "PHONE", deviceName: `Health check ${label}`,
  manufacturer: "aimess", brand: "aimess", model: "health-check", osVersion: "14", sdkInt: 34,
  appVersion: "0.0.0", appBuild: 0, buildType: "release", installerPackage: null, locale: "en-US", language: "en",
  country: null, timezone: "UTC", utcOffsetMinutes: 0, screenWidthPx: 1080, screenHeightPx: 2400,
  screenDensityDpi: 420, networkType: "WIFI", carrier: null, isEmulator: false, isRooted: false,
});

async function login(account, password, label) {
  const d = await api("auth/login", { method: "POST", body: { account, password, rememberMe: false, fcmTokens: [], device: device(label) } });
  const token = d?.tokens?.accessToken;
  if (!token) throw new Error("login ok but no accessToken in response");
  return { token, refreshToken: d.tokens.refreshToken, userId: jwtSub(token) };
}

async function livekitValidate(url, token) {
  const base = url.replace(/^ws/, "http").replace(/\/$/, "");
  const r = await http(`${base}/rtc/validate?access_token=${encodeURIComponent(token)}`);
  if (r.status !== 200) throw new Error(`LiveKit rejected token: HTTP ${r.status} ${r.text.slice(0, 120)}`);
}

// ── Checks ───────────────────────────────────────────────────────────────────
async function edgeChecks() {
  section("Infrastructure");
  await check("edge", "API gateway /health", async () => {
    const r = await http(`${API}/health`);
    if (r.status !== 200 || r.json?.success !== true) throw new Error(`HTTP ${r.status}`);
  });
  await check("edge", "Socket.IO handshake (polling)", async () => {
    const r = await http(`${API}/socket.io/?EIO=4&transport=polling`);
    if (r.status !== 200 || !r.text.includes("sid")) throw new Error(`HTTP ${r.status} ${r.text.slice(0, 80)}`);
  });
  await check("edge", "MinIO (media storage) live", async () => {
    const r = await http(`${MINIO}/minio/health/live`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  });
  await check("edge", "TLS certificate validity (api)", async () => {
    const days = await certDaysLeft(new URL(API).hostname);
    if (days < 0) throw new Error("certificate EXPIRED");
    if (days < 14) return warn(`expires in ${days} days`);
    return `${days} days left`;
  });
  await check("edge", "Public auth rejects bad token", async () => {
    const r = await http(`${API_V1}/users/profiles/me`, { token: "invalid.token.value" });
    if (r.status !== 401) throw new Error(`expected 401, got HTTP ${r.status}`);
  });

  section("Livestream infrastructure");
  await check("stream", "RTMP ingest port 1935", () => tcp(STREAM_HOST, Number(E.RTMP_PORT || 1935)));
  await check("stream", "HLS origin reachable", async () => {
    const r = await http(`${HLS_BASE}/`);
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });
  await check("stream", "WHIP ingest endpoint", async () => {
    const r = await http(WHIP_BASE, { method: "OPTIONS" });
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });
}

async function certDaysLeft(host) {
  const tls = await import("node:tls");
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: TIMEOUT }, () => {
      const cert = s.getPeerCertificate();
      s.end();
      resolve(Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000));
    });
    s.once("error", (e) => reject(new Error(e.code ?? e.message)));
    s.once("timeout", () => { s.destroy(); reject(new Error("timeout")); });
  });
}

async function webChecks() {
  section("Website");
  const pages = (E.WEB_PATHS || "/,/login,/create-new-account,/forgot-password,/message,/community,/notifications,/settings,/privacy-policy,/terms-of-service,/child-safety-standards,/delete-account").split(",");
  for (const p of pages) {
    await check("web", `Page ${p}`, async () => {
      const r = await http(`${WEB}${p}`);
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      if (!/<html|<!DOCTYPE/i.test(r.text)) throw new Error("response is not HTML");
      if (/Application error|Internal Server Error|__next_error__/i.test(r.text)) throw new Error("page rendered an error");
      return `HTTP ${r.status}`;
    });
  }
  await check("web", "JS bundles load", async () => {
    const r = await http(`${WEB}/`);
    const chunks = [...new Set([...r.text.matchAll(/\/_next\/static\/[^"'\s)]+\.js/g)].map((m) => m[0]))].slice(0, 8);
    if (!chunks.length) throw new Error("no /_next/static/*.js referenced from home page");
    const bad = [];
    for (const c of chunks) { const s = (await http(`${WEB}${c}`)).status; if (s !== 200) bad.push(`${c} → ${s}`); }
    if (bad.length) throw new Error(`broken: ${bad.join(", ")}`);
    return `${chunks.length} bundles OK`;
  });
  await check("web", "Push service worker", async () => {
    const r = await http(`${WEB}/firebase-messaging-sw.js`);
    if (r.status !== 200 || !/firebase/i.test(r.text)) throw new Error(`HTTP ${r.status}`);
  });
  await check("web", "Android app links (assetlinks.json)", async () => {
    const r = await http(`${WEB}/.well-known/assetlinks.json`);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`HTTP ${r.status}`);
  });
  await check("web", "Web origin allowed by API (CORS)", async () => {
    const r = await http(`${API_V1}/auth/login`, { method: "OPTIONS", headers: { origin: WEB, "access-control-request-method": "POST" } });
    const allow = r.headers.get("access-control-allow-origin");
    if (allow !== WEB && allow !== "*") throw new Error(`access-control-allow-origin=${allow ?? "missing"}`);
  });
}

// Read-only endpoints every signed-in screen depends on. Pure GETs: safe to hit on production.
const READ_ENDPOINTS = [
  ["Profile", "users/profiles/me"],
  ["Account", "users/accounts/me"],
  ["Settings", "users/settings/me"],
  ["Sessions (linked devices)", "auth/sessions"],
  ["Friends", "users/friends"],
  ["Friend requests", "users/friends/requests"],
  ["Blocked users", "users/friends/blocked"],
  ["Call-allowed friends", "users/settings/call-allowed-friends"],
  ["Recent searches", "users/recent-searches"],
  ["User search", "users/search?q=a&limit=5"],
  ["Global search", "search?q=a&limit=5"],
  ["Chat inbox", "chat/inbox?limit=10"],
  ["Unread summary", "chat/unread-summary"],
  ["Private conversations", "chat/private/conversations?limit=10"],
  ["My groups", "chat/groups/my-groups?limit=10"],
  ["Notifications", "chat/notifications?limit=10"],
  ["Notification unread count", "chat/notifications/unread-count"],
  ["Call history", "chat/calls?limit=10"],
  ["My communities", () => `communities/mine?scope=joined&limit=10&before_ts=${Date.now()}`],
  ["Discover communities", "communities/discover?limit=10"],
  ["Liked communities", "communities/liked?limit=10"],
  ["Community categories", "communities/categories"],
  ["My join requests", "communities/join-requests/mine"],
  ["My community invites", "communities/invites/mine"],
  ["Community rooms", "chat/community/rooms?limit=10"],
  ["Media usage", "media/usage/me"],
  ["GIF search (Giphy)", "media/gifs?q=hello&limit=5"],
];

async function apiSweep(A) {
  section("REST API (read-only sweep)");
  for (const [name, path] of READ_ENDPOINTS) {
    await check("api", name, async () => { await api(typeof path === "function" ? path() : path, { token: A.token }); });
  }
  await check("api", "App version policy", () => api("app-version/check", { method: "POST", token: A.token, body: { platform: "android", version: "99.0.0", osLevel: 34 } }).then(() => undefined));
}

async function mediaChecks(A) {
  section("Media pipeline");
  let objectKey;
  await check("media", "Presigned upload URL", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const d = await api("media/upload-url", { method: "POST", token: A.token, body: { category: "USER_AVATAR", contentType: "image/png", contentLength: png.length } });
    if (!d?.uploadUrl) throw new Error("no uploadUrl in response");
    // Exactly the signed headers (minus Content-Length, which fetch sets): a duplicate Content-Type breaks the signature.
    const { "Content-Length": _len, ...signed } = d.headers ?? { "Content-Type": "image/png" };
    const put = await http(d.uploadUrl, { method: "PUT", raw: png, headers: signed });
    if (put.status >= 300) throw new Error(`PUT to storage HTTP ${put.status} ${put.text.slice(0, 120)}`);
    objectKey = d.objectKey;
    return "uploaded to storage";
  });
  await check("media", "Confirm + antivirus scan", async () => {
    if (!objectKey) throw skip("upload failed");
    await api("media/confirm", { method: "POST", token: A.token, body: { objectKey, category: "USER_AVATAR", contentType: "image/png" } });
    for (let i = 0; i < 10; i++) {
      const s = await api(`media/scan-status?objectKey=${encodeURIComponent(objectKey)}&category=USER_AVATAR`, { token: A.token });
      const st = String(s?.status ?? s?.scanStatus ?? "").toUpperCase();
      if (/CLEAN|READY|PASSED|OK/.test(st)) return `scan ${st}`;
      if (/INFECT|REJECT|FAIL|BLOCK/.test(st)) throw new Error(`scan ${st}`);
      await sleep(1500);
    }
    return warn("scan still pending after 15s (ClamAV slow or stuck?)");
  });
  await check("media", "Download URL", async () => {
    if (!objectKey) throw skip("upload failed");
    const d = await api("media/download-url", { method: "POST", token: A.token, body: { objectKey, category: "USER_AVATAR" } });
    const url = d?.url ?? d?.downloadUrl;
    if (!url) throw new Error("no url in response");
    const r = await http(url);
    if (r.status !== 200) throw new Error(`GET from storage HTTP ${r.status}`);
  });
}

async function socketChecks(A) {
  section("Realtime sockets");
  const sockets = {};
  for (const ns of ["/chat", "/community", "/notify", "/stream"]) {
    await check("socket", `Namespace ${ns}`, async () => { sockets[ns] = await connectNs(ns, A.token); });
  }
  await check("socket", "Notifications fetch over socket", async () => {
    if (!sockets["/notify"]) throw skip("no /notify socket");
    await emitOk(sockets["/notify"], "notifications:fetch", { limit: 5 });
  });
  return sockets;
}

async function privateChatChecks(A, B, aChat, bChat) {
  section("Private chat (A ⇄ B, live)");
  let roomId, msgId;
  const clientId = uuid();
  const ok = await check("chat", "Open private room", async () => {
    const d = await api(`chat/private/rooms/${B.userId}`, { token: A.token });
    roomId = d?.roomId ?? d?.conversationId ?? idOf(d) ?? d?.room?.id ?? d?.room?.roomId;
    if (!roomId) throw new Error(`no room id in response: ${JSON.stringify(d).slice(0, 120)}`);
    for (const s of [aChat, bChat]) await emitAck(s, "conv:join", { conversationId: roomId, conversationType: "private", active: true }).catch(() => null);
    return roomId;
  });
  if (!ok) return;

  await check("chat", "Typing indicator reaches peer", async () => {
    const got = waitEvent(bChat, "typing:start", (p) => (p.conversationId ?? p.roomId) === roomId || p.userId === A.userId, 5000);
    aChat.emit("typing:start", { conversationId: roomId, conversationType: "private" });
    await got.catch(() => { throw new Error("peer did not get typing:start (or B disabled typing indicators)"); });
    aChat.emit("typing:stop", { conversationId: roomId, conversationType: "private" });
  });

  const sent = await check("chat", "Send message → peer receives live", async () => {
    const got = waitEvent(bChat, "message:new", sameMsg(clientId));
    const ack = await emitOk(aChat, "message:send", {
      conversationId: roomId, conversationType: "private", receiverId: B.userId, clientMessageId: clientId,
      contentType: "TEXT", contentText: `health-check ${new Date().toISOString()}`, clientTs: Date.now(),
    });
    msgId = idOf(ack);
    const m = await got;
    msgId ??= idOf(msgObj(m));
    if (!msgId) throw new Error("no message id in ack or event");
  });
  if (!sent) return;

  await check("chat", "Message in REST history", async () => {
    const d = await api(`chat/private/rooms/${roomId}/messages?limit=20`, { token: B.token });
    if (!listOf(d).some((m) => idOf(m) === msgId || (m.clientMessageId ?? "").toUpperCase() === clientId)) throw new Error("sent message not in history");
  });
  await check("chat", "Delta sync (catch-up)", () => api(`chat/sync?conv_id=${roomId}&from_seq=0&limit=20`, { token: B.token }).then(() => undefined));
  await check("chat", "Read receipt reaches sender", async () => {
    const got = waitEvent(aChat, "message:read", (p) => (p.conversationId ?? p.roomId) === roomId, 6000);
    bChat.emit("message:delivered", { conversationId: roomId, upToMessageId: msgId });
    await emitOk(bChat, "message:read", { conversationId: roomId, upToMessageId: msgId, conversationType: "private" });
    await got.catch(() => { throw new Error("sender got no message:read (B may hide read receipts)"); });
  });
  await check("chat", "Reaction reaches peer", async () => {
    const got = waitEvent(bChat, "message:reaction", (p) => idOf(p) === msgId || p.messageId === msgId);
    await emitOk(aChat, "message:react", { conversationId: roomId, messageId: msgId, emoji: "👍", conversationType: "private", mode: "set" });
    await got;
  });
  await check("chat", "Edit reaches peer", async () => {
    const got = waitEvent(bChat, "message:edited", (p) => idOf(p) === msgId || p.messageId === msgId);
    await emitOk(aChat, "message:edit", { conversationId: roomId, messageId: msgId, contentText: "health-check (edited)", conversationType: "private" });
    await got;
  });
  await check("chat", "Delete for everyone reaches peer", async () => {
    const got = waitEvent(bChat, "message:delete", (p) => p.messageId === msgId || idOf(p) === msgId || (p.messageIds ?? []).includes(msgId));
    await emitOk(aChat, "message:delete", { conversationId: roomId, messageId: msgId, type: "forEveryone", conversationType: "private" });
    await got;
  });
  await check("chat", "Presence of peer", async () => {
    await api(`chat/private/presence/${B.userId}`, { token: A.token });
  });
}

// Group chat (A owner, B member). The test group is created once and its id saved to .env.
async function groupChecks(A, B, aChat, bChat) {
  section("Group chat (A ⇄ B, live)");
  let roomId = E.GROUP_ID;
  if (!roomId) {
    const ok = await check("group", "Create test group", async () => {
      // Reuse a group left by an earlier run before creating one; chat APIs key groups by roomId (grp_…), not the Mongo id.
      const mine = await api("chat/groups/my-groups?limit=50", { token: A.token });
      let g = listOf(mine).find((x) => x.name === "Health Check group");
      g ??= await api("chat/groups", { method: "POST", token: A.token, body: { name: "Health Check group", description: "Automated post-deploy checks." } });
      roomId = g?.roomId ?? g?.group?.roomId ?? g?.room?.roomId;
      if (!roomId) throw new Error(`no room id: ${JSON.stringify(g).slice(0, 120)}`);
      if ((g?.memberCount ?? 1) < 2) await api("chat/group-members/add", { method: "POST", token: A.token, body: { roomId, userIds: [B.userId] } });
      const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
      writeFileSync(envFile, /^GROUP_ID=/m.test(env) ? env.replace(/^GROUP_ID=.*$/m, `GROUP_ID=${roomId}`) : `${env.trimEnd()}
GROUP_ID=${roomId}
`);
      return roomId;
    });
    if (!ok) return;
  }
  await check("group", "Group details + members", async () => {
    await api(`chat/groups/rooms/${roomId}`, { token: A.token });
    await api(`chat/group-members/${roomId}`, { token: A.token });
  });
  for (const s of [aChat, bChat]) await emitAck(s, "conv:join", { conversationId: roomId, conversationType: "group", active: true }).catch(() => null);

  let msgId;
  const clientId = uuid();
  const sent = await check("group", "Send message → member receives live", async () => {
    const got = waitEvent(bChat, "message:new", sameMsg(clientId));
    const ack = await emitOk(aChat, "message:send", {
      conversationId: roomId, conversationType: "group", clientMessageId: clientId,
      contentType: "TEXT", contentText: `health-check ${new Date().toISOString()}`, clientTs: Date.now(),
    });
    msgId = idOf(ack);
    const m = await got;
    msgId ??= idOf(msgObj(m));
    if (!msgId) throw new Error("no message id in ack or event");
  });
  if (!sent) return;
  await check("group", "Message in REST history", async () => {
    const d = await api(`chat/groups/rooms/${roomId}/messages?limit=20`, { token: B.token });
    if (!listOf(d).some((m) => idOf(m) === msgId || (m.clientMessageId ?? "").toUpperCase() === clientId)) throw new Error("sent message not in history");
  });
  await check("group", "Reaction reaches member", async () => {
    const got = waitEvent(bChat, "message:reaction", (p) => idOf(p) === msgId || p.messageId === msgId);
    await emitOk(aChat, "message:react", { conversationId: roomId, messageId: msgId, emoji: "👍", conversationType: "group", mode: "set" });
    await got;
  });
  await check("group", "Edit reaches member", async () => {
    const got = waitEvent(bChat, "message:edited", (p) => idOf(p) === msgId || p.messageId === msgId);
    await emitOk(aChat, "message:edit", { conversationId: roomId, messageId: msgId, contentText: "health-check (edited)", conversationType: "group" });
    await got;
  });
  await check("group", "Delete for everyone reaches member", async () => {
    const got = waitEvent(bChat, "message:delete", (p) => p.messageId === msgId || idOf(p) === msgId || (p.messageIds ?? []).includes(msgId));
    await emitOk(aChat, "message:delete", { conversationId: roomId, messageId: msgId, type: "forEveryone", conversationType: "group" });
    await got;
  });
}

async function communityChecks(A, B, sockets) {
  section("Community chat");
  const communityId = E.COMMUNITY_ID;
  if (!communityId) {
    await check("community", "Community send/receive", async () => { throw skip("set COMMUNITY_ID (a community A belongs to)"); });
    return;
  }
  await check("community", "Community details", () => api(`communities/${communityId}`, { token: A.token }).then(() => undefined));
  await check("community", "Community members", () => api(`communities/${communityId}/members?limit=10`, { token: A.token }).then(() => undefined));
  const s = sockets["/community"];
  if (!s) return;
  const joined = await check("community", "Join community room", () => emitOk(s, "community:join", { communityId, active: true }).then(() => undefined));
  if (!joined) return;
  let bCom;
  if (B) {
    await check("community", "Member B joins room", async () => {
      bCom = await connectNs("/community", B.token);
      await emitOk(bCom, "community:join", { communityId, active: true });
    });
  }
  let msgId;
  const clientId = uuid();
  const sent = await check("community", "Send message → member receives live", async () => {
    const got = bCom ? waitEvent(bCom, "community:message:new", sameMsg(clientId)) : null;
    const ack = await emitOk(s, "community:message:send", { communityId, clientMessageId: clientId, contentType: "TEXT", message: `health-check ${new Date().toISOString()}` });
    msgId = idOf(ack);
    if (!got) return warn("sent, but no second member to confirm delivery");
    const m = await got;
    msgId ??= idOf(msgObj(m));
    if (!msgId) throw new Error("no message id");
  });
  await check("community", "Community history (REST)", () => api(`chat/community/rooms/${communityId}/messages?limit=10`, { token: A.token }).then(() => undefined));
  if (sent && msgId) {
    await check("community", "Delete test message", () => emitOk(s, "community:message:delete", { communityId, roomId: communityId, messageId: msgId, type: "forEveryone" }).then(() => undefined));
  }
  s.emit("community:leave", { communityId });
  bCom?.close();
}

async function streamChecks(A, sockets) {
  section("Livestream (API + socket)");
  const s = sockets["/stream"];
  let live;
  await check("stream", "Find a live stream", async () => {
    if (!E.COMMUNITY_ID) throw skip("set COMMUNITY_ID");
    const d = await api(`streams?communityId=${E.COMMUNITY_ID}&status=LIVE&limit=5`, { token: A.token });
    live = listOf(d)[0];
    return live ? `${idOf(live)} "${live.title ?? ""}"` : "none live right now";
  });
  if (live && s) {
    const id = idOf(live);
    await check("stream", "Join live stream (viewer socket)", () => emitOk(s, "stream:join", { streamId: id }).then(() => undefined));
    await check("stream", "Stream comments (REST)", () => api(`streams/${id}/comments?limit=10`, { token: A.token }).then(() => undefined));
    await check("stream", "HLS playlist of live stream", async () => {
      const url = live.playbackUrl ?? live.hlsUrl ?? live.playback?.hls ?? live.urls?.hls;
      if (!url) return warn("no HLS url in stream object");
      const r = await http(url);
      if (r.status !== 200 || !r.text.includes("#EXTM3U")) throw new Error(`HTTP ${r.status}, not an m3u8`);
    });
    s.emit("stream:leave", { streamId: id });
  }
  if (!E.STREAM_COMMUNITY_ID) {
    await check("stream", "Create → publish creds → stop", async () => { throw skip("set STREAM_COMMUNITY_ID to test"); });
    return;
  }
  await check("stream", "Create → publish creds → stop", async () => {
    const st = await api("streams", { method: "POST", token: A.token, body: { communityId: E.STREAM_COMMUNITY_ID, title: "Health check (auto-stopped)", ingest: "rtmp" } });
    const id = idOf(st) ?? idOf(st?.stream);
    if (!id) throw new Error("created but no stream id in response");
    try {
      await api(`streams/${id}/publish-credentials`, { token: A.token });
      await api(`streams/${id}`, { token: A.token });
    } finally {
      await api(`streams/${id}/stop`, { method: "POST", token: A.token, body: {} });
    }
    return `stream ${id} created and stopped`;
  });
}

async function callChecks(A, B, aChat, bChat) {
  const callIds = [];
  section("Audio / video calls (LiveKit)");
  for (const callType of ["AUDIO", "VIDEO"]) {
    await check("call", `${callType.toLowerCase()} call end-to-end`, async () => {
      const incoming = waitEvent(bChat, "call:incoming");
      const ack = await emitAck(aChat, "call:initiate", { calleeId: B.userId, callType, legId: randomUUID() });
      if (!ack?.success) throw new Error(`initiate refused: ${ack?.error ?? ""} ${ack?.message ?? ""}`);
      const { callId, livekitUrl, token } = ack.data ?? {};
      callIds.push(callId);
      try {
        await incoming;
        const answer = await emitAck(bChat, "call:answer", { callId, legId: randomUUID() });
        if (!answer?.success) throw new Error(`answer refused: ${answer?.error ?? ""} ${answer?.message ?? ""}`);
        await livekitValidate(livekitUrl, token);
        await livekitValidate(answer.data.livekitUrl, answer.data.token);
      } finally {
        const ended = waitEvent(bChat, "call:ended", (p) => p.callId === callId).catch(() => null);
        await emitAck(aChat, "call:end", { callId, legId: "health-check" }).catch(() => null);
        if (!(await ended)) throw new Error("call:ended never reached callee");
      }
      return `signalling + LiveKit OK (${new URL(livekitUrl).host})`;
    });
    await sleep(1500);
  }
  await check("call", "Call shows in history", async () => {
    if (!callIds.length) throw skip("no call was placed");
    await sleep(2000);
    const d = await api("chat/calls?limit=20", { token: A.token });
    const body = JSON.stringify(d);
    const missing = callIds.filter((id) => !body.includes(id));
    if (missing.length) throw new Error(`${missing.length}/${callIds.length} test calls missing from history: ${body.slice(0, 160)}`);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${C.b}AIMESS post-deploy check${C.end}  api=${API}  web=${WEB}  stream=${STREAM_HOST}${ONLY.length ? `  only=${ONLY}` : ""}`);
  await edgeChecks();
  await webChecks();

  section("Accounts");
  if (!E.ACCOUNT_A || !E.PASSWORD_A) {
    await check("auth", "Login (account A)", async () => { throw skip("set ACCOUNT_A / PASSWORD_A in .env"); });
    return;
  }
  let A, B;
  if (!(await check("auth", "Login (account A)", async () => { A = await login(E.ACCOUNT_A, E.PASSWORD_A, "a"); }))) return;
  await check("auth", "Token refresh", async () => {
    const d = await api("auth/refresh", { method: "POST", body: { refreshToken: A.refreshToken } });
    const t = d?.tokens ?? d;
    if (!t?.accessToken) throw new Error("no accessToken in refresh response");
    A.token = t.accessToken;
    A.refreshToken = t.refreshToken ?? A.refreshToken;
  });
  if (E.ACCOUNT_B && E.PASSWORD_B) await check("auth", "Login (account B)", async () => { B = await login(E.ACCOUNT_B, E.PASSWORD_B, "b"); });
  else await check("auth", "Login (account B)", async () => { throw skip("set ACCOUNT_B / PASSWORD_B (friend of A) for chat + call checks"); });

  try {
    await apiSweep(A);
    await mediaChecks(A);
    const sockets = await socketChecks(A);
    let bChat;
    if (B && sockets["/chat"]) await check("socket", "Namespace /chat (account B)", async () => { bChat = await connectNs("/chat", B.token); });
    if (bChat) {
      await privateChatChecks(A, B, sockets["/chat"], bChat);
      await groupChecks(A, B, sockets["/chat"], bChat);
      await callChecks(A, B, sockets["/chat"], bChat);
    }
    await communityChecks(A, B, sockets);
    await streamChecks(A, sockets);
    bChat?.close();
    for (const s of Object.values(sockets)) s.close();
  } finally {
    for (const acc of [A, B]) if (acc) await http(`${API_V1}/auth/logout`, { method: "POST", token: acc.token, body: { refreshToken: acc.refreshToken } }).catch(() => null);
  }
}

await main().catch((e) => results.push({ group: "script", name: "crash", status: "fail", detail: e.stack }));

const by = (s) => results.filter((r) => r.status === s);
console.log(`\n${C.b}SUMMARY${C.end}  ${C.ok}${by("ok").length} ok${C.end}  ${C.warn}${by("warn").length} warn${C.end}  ${C.fail}${by("fail").length} failed${C.end}  ${C.skip}${by("skip").length} skipped${C.end}`);
for (const [label, s] of [["PROBLEMS", "fail"], ["WARNINGS", "warn"]]) {
  if (!by(s).length) continue;
  console.log(`\n${C[s]}${label}:${C.end}`);
  for (const r of by(s)) console.log(`  - [${r.group}] ${r.name}: ${r.detail}`);
}
if (!by("fail").length) console.log(`\n${C.ok}All checked systems are working.${C.end}${by("skip").length ? `  ${C.skip}(${by("skip").length} areas NOT tested - fill .env to cover them)${C.end}` : ""}`);
process.exit(by("fail").length ? 1 : 0);
