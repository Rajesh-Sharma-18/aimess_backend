/**
 * Live probe: does every session read in ITS OWN language, at the same time?
 *
 * The reported failure is a user seeing system messages, notification text and
 * conversation-list previews in a language they did not pick — most often the
 * language of whoever performed the action, or the server default. The
 * architecture answers that per SESSION (`socket.data.locale`) rather than per
 * account, so the only convincing proof is two live sockets of the SAME account
 * disagreeing about language while one event reaches both.
 *
 * What it drives, against the real stack:
 *
 *   A(th)  actor        — performs every action in Thai
 *   B(en)  recipient    — session 1 of the recipient account
 *   B(vi)  recipient    — session 2 of the SAME account, different language
 *
 *   1. actor's language never reaches the recipient (A th → B en stays en)
 *   2. two sessions of one account render one event in two languages
 *   3. `locale:set` retargets ONE session live, leaving its sibling alone
 *   4. a reconnect restores the session's language from the handshake
 *   5. an unsupported locale is ignored, not normalized onto the default
 *   6. REST (`x-lang`) renders the list preview and the transcript per request
 *   7. the same stored row re-renders after a language switch (no logout)
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> pnpm exec tsx scripts/probe-i18n-sessions.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const API = process.env.GATEWAY_API ?? "http://localhost:3000/api/v1";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";

const USERS = [
  process.env.ACTOR_ID ?? "7b0db132-ffff-4d99-ab3c-421f83fba2ef",
  process.env.RECIPIENT_ID ?? "1b98aed5-cc15-41d6-95bb-bef47a44f063",
  process.env.VICTIM_ID ?? "246a48a1-8574-40c2-99c2-662343fedc4c",
];
// Assigned once the fixture exists: whoever managed to create the group IS the
// actor, because only the creator is its admin. Group creation is rate-limited
// per user and this probe is meant to be re-runnable, so the roles follow the
// limiter rather than the limiter blocking the run.
let ACTOR = USERS[0];
let RECIPIENT = USERS[1];
let VICTIM = USERS[2];

if (!SECRET) {
  console.error("JWT_ACCESS_SECRET is required.");
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One token per SESSION: the session id is what the locale is scoped to. */
const tokenFor = (userId: string, sessionId: string): string =>
  signAccessToken({ userId, sessionId, secret: SECRET, expiresInSeconds: 7200 });

async function api(
  user: string,
  method: string,
  path: string,
  body?: unknown,
  lang?: string
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokenFor(user, randomUUID())}`,
      "Content-Type": "application/json",
      ...(lang ? { "x-lang": lang } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

interface Frame {
  event: string;
  at: number;
  data: any;
}

interface Session {
  label: string;
  socket: Socket;
  frames: Frame[];
  sessionId: string;
  userId: string;
  close: () => void;
}

/**
 * A session carries its language in BOTH `auth` and `query`, which is the client
 * contract: a browser cannot set headers on a websocket upgrade, and which of
 * the two survives depends on the transport that gets negotiated.
 */
async function openSession(
  userId: string,
  lang: string,
  label: string,
  sessionId = randomUUID()
): Promise<Session> {
  const token = tokenFor(userId, sessionId);
  const socket: Socket = io(`${GW}/chat`, {
    transports: ["websocket"],
    auth: { token, lang },
    query: { lang, platform: "WEB" },
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (e: Error) => reject(e));
    setTimeout(() => reject(new Error(`${label} connect timeout`)), 10000);
  });
  const frames: Frame[] = [];
  socket.onAny((event: string, ...args: unknown[]) => {
    frames.push({ event, at: Date.now(), data: args[0] });
  });
  return {
    label,
    socket,
    frames,
    sessionId,
    userId,
    close: () => socket.close(),
  };
}

const joinRoom = async (s: Session, roomId: string): Promise<void> => {
  await new Promise<void>((resolve) => {
    s.socket.emit(
      "conv:join",
      { conversationId: roomId, conversationType: "group", active: false },
      () => resolve()
    );
    setTimeout(resolve, 3000);
  });
};

/** Every SYSTEM sentence this session was shown for `roomId`, in order. */
function systemLines(s: Session, roomId: string): string[] {
  const out: string[] = [];
  for (const f of s.frames) {
    const d = f.data as any;
    if (!d || typeof d !== "object") continue;
    const message = d.message ?? d;
    const rid = message?.roomId ?? message?.conversationId ?? d.roomId;
    if (rid !== roomId) continue;
    const type = message?.contentType ?? message?.messageType ?? message?.type;
    const text = message?.content?.text ?? message?.text;
    if (type === "SYSTEM" && typeof text === "string" && text) out.push(text);
  }
  return out;
}

/** The conversation-list preview this session was pushed for `roomId`. */
function listPreviews(s: Session, roomId: string): string[] {
  const out: string[] = [];
  for (const f of s.frames) {
    const d = f.data as any;
    if (!d || typeof d !== "object") continue;
    const rid = d.roomId ?? d.conversationId ?? d.id;
    if (rid !== roomId) continue;
    const last = d.lastMessage;
    if (last?.contentType !== "SYSTEM") continue;
    const preview = last?.text ?? last?.content?.text ?? d.preview;
    if (typeof preview === "string" && preview) out.push(preview);
  }
  return out;
}

const clear = (...sessions: Session[]): void => {
  for (const s of sessions) s.frames.length = 0;
};

/** A locale is proven by the script its sentence is actually written in. */
const isThai = (s: string): boolean => /[฀-๿]/.test(s);
const isVietnamese = (s: string): boolean =>
  /[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(s);
const isPlainLatin = (s: string): boolean => !isThai(s) && !isVietnamese(s);

async function main(): Promise<void> {
  // ── fixture: a group its creator owns, with the other two users in it ────
  //
  // Built BEFORE any socket is opened, because which user turns out to be the
  // actor depends on who is allowed to create a group right now.
  const sfx = Math.random().toString(36).slice(2, 8);
  let roomId = "";
  for (const candidate of USERS) {
    const created = await api(candidate, "POST", "/chat/groups", {
      name: `I18N ${sfx}`,
      description: "locale probe",
    });
    // The member/message endpoints address a group by its roomId (grp_…), not
    // by the Mongo id the same row also carries.
    const rid = (created.json?.data?.roomId ??
      created.json?.data?.room?.roomId) as string | undefined;
    if (rid) {
      roomId = rid;
      ACTOR = candidate;
      [RECIPIENT, VICTIM] = USERS.filter((u) => u !== candidate);
      break;
    }
    console.log(
      `NOTE  ${candidate.slice(0, 8)} cannot create a group right now (${String(
        created.json?.error?.code ?? created.status
      )})`
    );
  }
  check("fixture: group created", Boolean(roomId), `roomId=${roomId}`);
  if (!roomId) process.exit(1);

  const added = await api(ACTOR, "POST", "/chat/group-members/add", {
    roomId,
    userIds: [RECIPIENT, VICTIM],
  });
  check(
    "fixture: both other users are members",
    added.status === 200 || added.status === 201,
    `status=${added.status} ${JSON.stringify(added.json?.error ?? "")}`
  );

  // ── sessions ────────────────────────────────────────────────────────────
  const actorTh = await openSession(ACTOR, "th", "actor(th)");
  const recipEn = await openSession(RECIPIENT, "en", "recipient(en)");
  const recipVi = await openSession(RECIPIENT, "vi", "recipient(vi)");
  check(
    "two sessions of ONE account are connected with different languages",
    recipEn.sessionId !== recipVi.sessionId
  );

  await Promise.all([
    joinRoom(actorTh, roomId),
    joinRoom(recipEn, roomId),
    joinRoom(recipVi, roomId),
  ]);
  await sleep(1200);

  // ── 1+2. one action, three sessions, three languages ────────────────────
  // (VICTIM stays in the fixture only as the third account some environments
  //  allow to be added; nothing below depends on it.)
  clear(actorTh, recipEn, recipVi);
  // A role change rather than a removal: it is a SYSTEM line every member sees,
  // it is available to the group admin unconditionally, and it leaves the
  // fixture usable for the next two events.
  const kicked = await api(ACTOR, "POST", "/chat/group-members/role", {
    roomId,
    userId: RECIPIENT,
    role: "MODERATOR",
  });
  check(
    "fixture: the role change was accepted",
    kicked.status === 200 || kicked.status === 201,
    JSON.stringify(kicked.json?.error ?? kicked.json?.message ?? kicked.status)
  );
  await sleep(2500);

  const aLines = systemLines(actorTh, roomId);
  const enLines = systemLines(recipEn, roomId);
  const viLines = systemLines(recipVi, roomId);
  check(
    "the role change reached every session",
    aLines.length > 0 && enLines.length > 0 && viLines.length > 0,
    `actor=${aLines.length} en=${enLines.length} vi=${viLines.length}`
  );
  check(
    "actor session (th) reads Thai",
    aLines.some(isThai),
    aLines.join(" | ")
  );
  check(
    "recipient session (en) reads English — the ACTOR's Thai never reached it",
    enLines.length > 0 && enLines.every(isPlainLatin),
    enLines.join(" | ")
  );
  check(
    "sibling session of the SAME account (vi) reads Vietnamese at the same time",
    viLines.some(isVietnamese),
    viLines.join(" | ")
  );
  check(
    "the two sessions of one account did NOT converge on one language",
    enLines.join("|") !== viLines.join("|")
  );

  // ── list preview (lastActivity) rides the same rule ──────────────────────
  const enPrev = listPreviews(recipEn, roomId);
  const viPrev = listPreviews(recipVi, roomId);
  if (enPrev.length > 0 || viPrev.length > 0) {
    check(
      "live list preview is per session",
      enPrev.every(isPlainLatin) && (viPrev.length === 0 || viPrev.some(isVietnamese)),
      `en=${enPrev.join("|")} vi=${viPrev.join("|")}`
    );
  }

  // ── 3. locale:set retargets ONE session, live ───────────────────────────
  const setAck = await new Promise<any>((resolve) => {
    recipVi.socket.emit("locale:set", { lang: "th" }, (res: unknown) => resolve(res));
    setTimeout(() => resolve(undefined), 3000);
  });
  check(
    "locale:set acks the new locale",
    setAck?.success === true && setAck?.data?.locale === "th",
    JSON.stringify(setAck)
  );

  clear(actorTh, recipEn, recipVi);
  await api(ACTOR, "POST", "/chat/group-members/role", {
    roomId,
    userId: RECIPIENT,
    role: "MEMBER",
  });
  await sleep(2500);
  const enAfter = systemLines(recipEn, roomId);
  const viAfter = systemLines(recipVi, roomId);
  check(
    "the retargeted session now reads Thai — with no reconnect and no logout",
    viAfter.some(isThai),
    viAfter.join(" | ")
  );
  check(
    "its sibling session is untouched and still reads English",
    enAfter.length > 0 && enAfter.every(isPlainLatin),
    enAfter.join(" | ")
  );

  // ── 5. an unsupported locale is IGNORED, not normalized ─────────────────
  const badAck = await new Promise<any>((resolve) => {
    recipEn.socket.emit("locale:set", { lang: "xx-YY" }, (res: unknown) => resolve(res));
    setTimeout(() => resolve(undefined), 3000);
  });
  check(
    "an unsupported locale is refused and the previous one kept",
    badAck?.success === false && badAck?.data?.locale === "en",
    JSON.stringify(badAck)
  );

  // ── 4. reconnect restores the session's language from the handshake ─────
  recipEn.close();
  await sleep(500);
  const recipEn2 = await openSession(
    RECIPIENT,
    "en",
    "recipient(en, reconnected)",
    recipEn.sessionId
  );
  await joinRoom(recipEn2, roomId);
  await sleep(800);
  clear(actorTh, recipEn2, recipVi);
  await api(ACTOR, "POST", "/chat/group-members/role", {
    roomId,
    userId: RECIPIENT,
    role: "MODERATOR",
  });
  await sleep(2500);
  const reconnected = systemLines(recipEn2, roomId);
  check(
    "after a reconnect the session still reads English, not the server default",
    reconnected.length > 0 && reconnected.every(isPlainLatin),
    reconnected.join(" | ")
  );

  // ── 6+7. REST: the SAME stored rows, read in three languages ────────────
  const transcript = async (lang: string): Promise<string[]> => {
    const r = await api(
      RECIPIENT,
      "GET",
      `/chat/groups/rooms/${roomId}/messages?limit=30`,
      undefined,
      lang
    );
    const rows = r.json?.data?.data ?? r.json?.data?.messages ?? [];
    return (Array.isArray(rows) ? rows : [])
      .filter((m: any) => (m.contentType ?? m.messageType ?? m.type) === "SYSTEM")
      .map((m: any) => String(m.content?.text ?? m.text ?? ""))
      .filter(Boolean);
  };
  const [tEn, tVi, tTh] = await Promise.all([
    transcript("en"),
    transcript("vi"),
    transcript("th"),
  ]);
  check(
    "REST transcript renders per x-lang (en)",
    tEn.length > 0 && tEn.every(isPlainLatin),
    tEn.slice(0, 2).join(" | ")
  );
  check(
    "REST transcript renders per x-lang (vi)",
    tVi.some(isVietnamese),
    tVi.slice(0, 2).join(" | ")
  );
  check(
    "REST transcript renders per x-lang (th) — history re-renders after a switch",
    tTh.some(isThai),
    tTh.slice(0, 2).join(" | ")
  );

  const inboxPreview = async (lang: string): Promise<string> => {
    const r = await api(RECIPIENT, "GET", "/chat/inbox?limit=30", undefined, lang);
    const rows = r.json?.data?.data ?? r.json?.data?.conversations ?? [];
    const row = (Array.isArray(rows) ? rows : []).find(
      (c: any) => (c.roomId ?? c.id ?? c.conversationId) === roomId
    );
    return String(
      row?.lastMessage?.content?.text ??
        row?.lastMessagePreview?.text ??
        row?.lastActivity?.preview ??
        ""
    );
  };
  const [pEn, pVi, pTh] = await Promise.all([
    inboxPreview("en"),
    inboxPreview("vi"),
    inboxPreview("th"),
  ]);
  check(
    "lastActivity preview renders per x-lang (en)",
    pEn.length > 0 && isPlainLatin(pEn),
    pEn
  );
  check("lastActivity preview renders per x-lang (vi)", isVietnamese(pVi), pVi);
  check("lastActivity preview renders per x-lang (th)", isThai(pTh), pTh);

  // ── notification list, same three languages ─────────────────────────────
  const notifications = async (lang: string): Promise<string[]> => {
    const r = await api(RECIPIENT, "GET", "/chat/notifications?limit=20", undefined, lang);
    const rows = r.json?.data?.data ?? [];
    return (Array.isArray(rows) ? rows : [])
      .map((n: any) => String(n.body ?? n.payload?.body ?? ""))
      .filter(Boolean);
  };
  const [nEn, nVi, nTh] = await Promise.all([
    notifications("en"),
    notifications("vi"),
    notifications("th"),
  ]);
  if (nEn.length > 0) {
    check(
      "notification list renders per x-lang",
      nEn.join("|") !== nVi.join("|") || nEn.join("|") !== nTh.join("|"),
      `en=${nEn[0]} vi=${nVi[0]} th=${nTh[0]}`
    );
  } else {
    console.log("SKIP  notification list — recipient has no inbox rows");
  }

  actorTh.close();
  recipEn2.close();
  recipVi.close();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
