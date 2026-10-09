#!/usr/bin/env node
// One-time: creates two test accounts (friends), a test community, and writes them into .env.
// Safe to re-run: does nothing if .env already has ACCOUNT_A.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const envPath = new URL("./.env", import.meta.url);
if (!existsSync(envPath)) copyFileSync(new URL("./.env.example", import.meta.url), envPath);
let envText = readFileSync(envPath, "utf8");
const get = (k) => envText.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
const set = (k, v) => {
  envText = new RegExp(`^${k}=`, "m").test(envText) ? envText.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${envText.trimEnd()}\n${k}=${v}\n`;
};

if (get("ACCOUNT_A") && process.argv[2] !== "--force") {
  console.log(`Test data already set up (ACCOUNT_A=${get("ACCOUNT_A")}). Use --force to create a fresh set.`);
  process.exit(0);
}

const API_V1 = `${(get("API_ORIGIN") || "https://api.ai5dev.tech").replace(/\/$/, "")}/api/v1`;

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API_V1}/${path}`, {
    method,
    headers: { "content-type": "application/json", "x-lang": "en", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok || json?.success === false) {
    throw new Error(`${method} ${path} → HTTP ${res.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? json?.message ?? text.slice(0, 200)}`);
  }
  return json?.data ?? json;
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

async function solveProof() {
  const { challenge, difficultyBits } = await api("auth/challenge", { method: "POST" });
  for (let n = 0; ; n++) {
    const solution = String(n);
    if (leadingZeroBits(createHash("sha256").update(`${challenge}.${solution}`).digest()) >= difficultyBits) return { challenge, solution };
  }
}

const tag = randomBytes(3).toString("hex");
const password = () => `Hc!${randomBytes(9).toString("base64url")}9a`;

async function createAccount(label) {
  const account = `hc_${label}_${tag}`;
  const pass = password();
  const reg = await api("auth/register", { method: "POST", body: { account, password: pass, fcmTokens: [], proof: await solveProof() } });
  const token = reg?.tokens?.accessToken;
  if (!token) throw new Error("register returned no accessToken");
  const userId = reg?.user?.userId ?? JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  await api("users/profiles/me", {
    method: "PATCH", token,
    body: { firstName: "Health", lastName: `Check ${label.toUpperCase()}`, username: account, dateOfBirth: "1995-01-01" },
  });
  console.log(`  created ${account} (${userId})`);
  return { account, pass, token, userId };
}

console.log(`Setting up test data on ${API_V1}`);
const A = await createAccount("a");
const B = await createAccount("b");

const fr = await api("users/friends/requests", { method: "POST", token: A.token, body: { addresseeId: B.userId } });
const friendshipId = fr?.id ?? fr?.friendshipId ?? fr?.friendship?.id;
if (fr?.status !== "ACCEPTED") {
  if (!friendshipId) throw new Error(`friend request returned no id: ${JSON.stringify(fr).slice(0, 200)}`);
  await api(`users/friends/requests/${friendshipId}/accept`, { method: "POST", token: B.token });
}
console.log("  A and B are now friends");

const cats = await api("communities/categories", { token: A.token });
const category = (Array.isArray(cats) ? cats : cats?.categories ?? cats?.items ?? [])[0];
const categoryId = category?.id ?? category?._id;
if (!categoryId) throw new Error("no community category available");
const community = await api("communities", {
  method: "POST", token: A.token,
  body: { name: `Health Check ${tag}`, handle: `hc_${tag}`, type: "PRIVATE", categoryId, description: "Automated post-deploy checks. Safe to ignore.", memberIds: [B.userId] },
});
const communityId = community?.id ?? community?._id ?? community?.community?.id;
if (!communityId) throw new Error(`community created but no id: ${JSON.stringify(community).slice(0, 200)}`);
console.log(`  created private community "Health Check ${tag}" (${communityId})`);

set("ACCOUNT_A", A.account); set("PASSWORD_A", A.pass);
set("ACCOUNT_B", B.account); set("PASSWORD_B", B.pass);
set("COMMUNITY_ID", communityId); set("STREAM_COMMUNITY_ID", communityId);
writeFileSync(envPath, envText);
console.log("\nDone. Credentials saved to .env — now run the check.");
