import fs from "node:fs";
import { io } from "socket.io-client";
export const API = process.env.API ?? "http://localhost:3000/api/v1";
export const WS = process.env.WS ?? "http://localhost:3000";
const CACHE = process.env.TOKCACHE ?? `${process.env.BURST_BENCH_OUT ?? "."}/tok.json`;

const jwtSub = (t) => {
  const p = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
  return p.userId ?? p.sub ?? p.id;
};

export async function loginCached(key, account, password) {
  account = account ?? process.env[`${key}_ACC`];
  password = password ?? process.env[`${key}_PW`];
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch {}
  const hit = cache[key];
  if (hit && hit.exp > Date.now() + 60000) return hit;
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account, password, rememberMe: true }) });
  const j = await r.json();
  if (!j?.success) throw new Error(`login ${key}: ${j?.code} ${j?.message}`);
  const tk = j.data.tokens;
  const rec = { token: tk.accessToken, refresh: tk.refreshToken, userId: jwtSub(tk.accessToken), exp: Date.now() + Math.min(tk.accessTokenExpiresIn * 1000, 30 * 60000) };
  cache[key] = rec;
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return rec;
}

export function connect(token, ns = "/chat", opts = {}) {
  const batch = opts.batch === false ? undefined : "1";
  return new Promise((res, rej) => {
    const s = io(`${WS}${ns}`, { forceNew: true, multiplex: false, transports: ["websocket"], auth: { token, access_token: token, lang: "en", ...(batch ? { batch } : {}) }, query: { token, platform: "web", lang: "en", ...(batch ? { batch } : {}) } });
    s.on("connect", () => res(s));
    s.on("disconnect", (r) => console.log(`[socket ${ns}] DISCONNECT ${r}`));
    s.on("session:expired", () => console.log(`[socket ${ns}] SESSION_EXPIRED`));
    s.on("error", (e) => console.log(`[socket ${ns}] ERROR ${JSON.stringify(e).slice(0,120)}`));
    s.on("connect_error", (e) => rej(new Error(`connect_error ${e.message}`)));
    setTimeout(() => rej(new Error("connect timeout")), 15000);
  });
}

export const ack = (s, ev, payload, ms = 15000) =>
  new Promise((res) => { const t = setTimeout(() => res({ __timeout: true }), ms); s.emit(ev, payload, (r) => { clearTimeout(t); res(r); }); });

export const api = async (token, path, opts = {}) => {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers ?? {}) } });
  return r.json();
};
