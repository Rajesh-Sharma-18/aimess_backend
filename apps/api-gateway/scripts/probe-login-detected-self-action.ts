/**
 * Live probe: can the session that CAUSED a "Login Detected" alert act on it?
 *
 * The rule under test is per NOTIFICATION and per SESSION, never per account
 * and never "newest device": every alert names the session that produced it,
 * and only the account's OTHER sessions may answer that one. Both sides belong
 * to the same user, so nothing about `userId` can decide it.
 *
 * Drives three real logins of one fresh account against the running stack:
 *
 *   A  logs in first
 *   B  logs in second   → alert N(B)
 *   C  logs in third    → alert N(C)
 *
 * and checks, per alert, who lists it, who is told they may act, and whether
 * the backend refuses a triggering session that skips the UI and calls the
 * action endpoints directly.
 *
 * Usage (from apps/api-gateway):
 *   pnpm exec tsx scripts/probe-login-detected-self-action.ts
 */
import { createHash, randomBytes } from "node:crypto";

const API = process.env.GATEWAY_API ?? "http://localhost:3000/api/v1";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
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

/** Hashcash solver for POST /auth/challenge — the signup gate. */
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
}

async function login(
  account: string,
  password: string,
  label: string
): Promise<Sess> {
  const r = await call("POST", "/auth/login", {
    account,
    password,
    device: device(
      `probe-${label}-${randomBytes(4).toString("hex")}`,
      `Probe ${label}`
    ),
  });
  if (r.status !== 200) {
    throw new Error(`login ${label} → ${r.status} ${JSON.stringify(r.json)}`);
  }
  const d = r.json.data ?? r.json;
  const token = d.tokens?.accessToken ?? d.accessToken;
  // The login body carries no session id; the access token's `sid` claim is
  // the same value every service scopes the request to.
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8")
  ) as { sid?: string };
  return { label, token, sessionId: claims.sid ?? "" };
}

interface LoginRow {
  id: string;
  trigger: string;
  actions?: { canTerminate: boolean; canConfirm: boolean };
  actionTaken?: string;
}

async function loginRows(s: Sess): Promise<LoginRow[]> {
  const r = await call("GET", "/chat/notifications?limit=50", undefined, s.token);
  const rows = r.json?.data?.data ?? [];
  return (Array.isArray(rows) ? rows : [])
    .filter((n: any) => n.type === "auth.security_new_login")
    .map((n: any) => ({
      id: n.id,
      trigger: n.payload?.data?.sessionId ?? "",
      actions: n.actions,
      actionTaken: n.actionTaken,
    }));
}

const rowFor = (rows: LoginRow[], s: Sess): LoginRow | undefined =>
  rows.find((r) => r.trigger === s.sessionId);

const actionable = (r?: LoginRow): boolean =>
  Boolean(r?.actions?.canTerminate && r.actions.canConfirm);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Does this session still authenticate against a protected endpoint? */
async function stillAlive(s: Sess): Promise<boolean> {
  const r = await call("GET", "/auth/sessions", undefined, s.token);
  return r.status === 200;
}

async function main(): Promise<void> {
  // ---- fresh account -------------------------------------------------------
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
  if (reg.status !== 201 && reg.status !== 200) {
    throw new Error(`register → ${reg.status} ${JSON.stringify(reg.json)}`);
  }
  console.log(`account=${account}`);

  // ---- three sessions, in order -------------------------------------------
  const A = await login(account, password, "A");
  await sleep(1500);
  const B = await login(account, password, "B");
  await sleep(1500);
  const C = await login(account, password, "C");
  console.log(`A=${A.sessionId}\nB=${B.sessionId}\nC=${C.sessionId}`);

  // RabbitMQ → notifications-service → chat-service is async; give it room.
  await sleep(6000);

  const rowsA = await loginRows(A);
  const rowsB = await loginRows(B);
  const rowsC = await loginRows(C);
  for (const [s, rows] of [
    [A, rowsA],
    [B, rowsB],
    [C, rowsC],
  ] as const) {
    console.log(
      `\n[${s.label}] ${rows.length} login row(s):\n` +
        rows
          .map(
            (n) =>
              `   trigger=${n.trigger} actions=${JSON.stringify(n.actions)} actionTaken=${n.actionTaken ?? "-"}`
          )
          .join("\n")
    );
  }
  console.log("");

  // ---- TEST 1 / 6 / 7 — per-notification, per-session ----------------------
  check("A may act on B's alert", actionable(rowFor(rowsA, B)));
  check("C may act on B's alert", actionable(rowFor(rowsC, B)));
  check(
    "B may NOT act on its own alert",
    !actionable(rowFor(rowsB, B)),
    rowFor(rowsB, B) ? "row listed but not actionable" : "row not listed at all"
  );
  check("A may act on C's alert", actionable(rowFor(rowsA, C)));
  check(
    "B may act on C's alert (not 'newest device', per notification)",
    actionable(rowFor(rowsB, C))
  );
  check(
    "C may NOT act on its own alert",
    !actionable(rowFor(rowsC, C)),
    rowFor(rowsC, C) ? "row listed but not actionable" : "row not listed at all"
  );

  // ---- TEST 8 — two tabs of ONE session share its verdict ------------------
  const bTab2: Sess = { ...B, label: "B-tab2" };
  check(
    "a second tab of B's session is judged the same (session, not tab)",
    !actionable(rowFor(await loginRows(bTab2), B))
  );

  // ---- TEST 4 — API bypass from the triggering session ---------------------
  // B cannot list its own row, so take the id from a session that can see it.
  const bRowId = rowFor(rowsA, B)?.id ?? "";
  if (!bRowId) throw new Error("A never received B's login alert — cannot continue");

  const selfConfirm = await call(
    "PATCH",
    `/chat/notifications/${bRowId}/action`,
    { action: "CONFIRM", body: "This was you." },
    B.token
  );
  check(
    "B's direct PATCH .../action (CONFIRM) on its own alert is refused",
    selfConfirm.status === 403,
    `status=${selfConfirm.status}`
  );

  const selfTerminate = await call(
    "PATCH",
    `/chat/notifications/${bRowId}/action`,
    { action: "TERMINATE", body: "Session terminated." },
    B.token
  );
  check(
    "B's direct PATCH .../action (TERMINATE) on its own alert is refused",
    selfTerminate.status === 403,
    `status=${selfTerminate.status}`
  );

  const selfTrust = await call(
    "POST",
    `/auth/sessions/${B.sessionId}/trust`,
    {},
    B.token
  );
  check(
    "B's direct POST /auth/sessions/<self>/trust is refused",
    selfTrust.status === 403,
    `status=${selfTrust.status}`
  );

  // The refusals must have changed nothing.
  check("B's alert is still unresolved after the refusals", !rowFor(await loginRows(A), B)?.actionTaken);
  check("B is still signed in after the refusals", await stillAlive(B));

  // ---- TEST 3 — "It's Me" from A, on C's alert -----------------------------
  const cRowId = rowFor(rowsA, C)?.id ?? "";
  const trustC = await call(
    "POST",
    `/auth/sessions/${C.sessionId}/trust`,
    {},
    A.token
  );
  check("A's 'It's Me' on C's alert is accepted", trustC.status === 200,
    `status=${trustC.status}`);
  await sleep(1500);
  check("C stays signed in after 'It's Me'", await stillAlive(C));
  const cResolved = rowFor(await loginRows(A), C);
  check("C's alert reads resolved for A", cResolved?.actionTaken === "TRUSTED",
    `actionTaken=${cResolved?.actionTaken ?? "-"}`);
  check("C's alert offers A no further action", !actionable(cResolved));

  // Race / idempotence: a second answer to a settled alert must not flip it.
  const trustCAgain = await call(
    "POST",
    `/auth/sessions/${C.sessionId}/trust`,
    {},
    B.token
  );
  const cAfter = rowFor(await loginRows(A), C);
  check(
    "a second answer to C's settled alert does not change its outcome",
    cAfter?.actionTaken === "TRUSTED",
    `status=${trustCAgain.status} actionTaken=${cAfter?.actionTaken ?? "-"}`
  );

  // ---- TEST 2 — "Terminate" from A, on B's alert ---------------------------
  const patchB = await call(
    "PATCH",
    `/chat/notifications/${bRowId}/action`,
    { action: "TERMINATE", body: "Session terminated." },
    A.token
  );
  const revokeB = await call(
    "DELETE",
    `/auth/sessions/${B.sessionId}`,
    undefined,
    A.token
  );
  check("A's Terminate on B's alert is accepted",
    patchB.status === 200 && revokeB.status === 200,
    `action=${patchB.status} revoke=${revokeB.status}`);
  await sleep(2000);
  check("B's session is dead", !(await stillAlive(B)));
  check("A is still signed in", await stillAlive(A));
  const bResolved = rowFor(await loginRows(A), B);
  check("B's alert reads terminated for A",
    bResolved?.actionTaken?.startsWith("TERMINATE") === true,
    `actionTaken=${bResolved?.actionTaken ?? "-"}`);
  check("B's alert offers A no further action", !actionable(bResolved));

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
