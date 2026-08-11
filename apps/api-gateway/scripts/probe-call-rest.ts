/**
 * Companion to probe-call-realtime.ts: the RECOVERY half of the contract.
 *
 * A call card must survive a reload (REST history), must be replayable by the
 * reconnect path (`/changes?since_revision=`), and must carry the conversation
 * in the inbox with the call as its last activity. Same stack, same room.
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";

const GW = process.env.GATEWAY_URL ?? "http://localhost:3000/api/v1";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const ROOM = process.env.ROOM ?? "";
const A = process.env.USER_A ?? "";

if (!SECRET || !ROOM || !A) {
  console.error("ROOM, USER_A and JWT_ACCESS_SECRET are required.");
  process.exit(2);
}

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
};

const token = signAccessToken({
  userId: A,
  sessionId: randomUUID(),
  secret: SECRET,
  expiresInSeconds: 3600,
});

async function get(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${GW}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { data?: Record<string, unknown> };
  if (res.status !== 200) {
    console.error(`GET ${path} -> ${res.status} ${JSON.stringify(body)}`);
    process.exit(2);
  }
  return (body.data ?? body) as Record<string, unknown>;
}

interface Row {
  id: string;
  contentType?: string;
  messageType?: string;
  revision?: number;
  content?: { call?: { callStatus?: string; callType?: string } };
}

const isCall = (m: Row): boolean =>
  Boolean(m.content?.call) ||
  ["VOICE_CALL", "VIDEO_CALL"].includes(
    String(m.contentType ?? m.messageType ?? "").toUpperCase()
  );

async function main(): Promise<void> {
  // ---- reload: REST history still has the cards -----------------------------
  const history = await get(`/chat/private/rooms/${ROOM}/messages?limit=50`);
  const rows = (history.items ??
    history.messages ??
    history.data ??
    []) as Row[];
  const calls = rows.filter(isCall);
  check(
    "REST history returns call rows after the call",
    calls.length > 0,
    `calls=${calls.length}/${rows.length}`
  );
  check(
    "every call row keeps VOICE_CALL/VIDEO_CALL on reload",
    calls.every((m) =>
      ["VOICE_CALL", "VIDEO_CALL"].includes(
        String(m.contentType ?? m.messageType ?? "").toUpperCase()
      )
    ),
    calls.map((m) => m.contentType ?? m.messageType).join(",")
  );
  check(
    "no call row is left mid-lifecycle in history",
    calls.every((m) =>
      ["ENDED", "DECLINED", "CANCELLED", "MISSED", "FAILED"].includes(
        String(m.content?.call?.callStatus ?? "").toUpperCase()
      )
    ),
    calls.map((m) => m.content?.call?.callStatus).join(",")
  );
  const ids = calls.map((m) => m.id);
  check("one row per call (no duplicates)", new Set(ids).size === ids.length);

  // ---- reconnect: /changes replays the settled state ------------------------
  const minRev = Math.min(
    ...calls.map((m) => Number(m.revision ?? 0)).filter((n) => n > 0)
  );
  const since = Number.isFinite(minRev) && minRev > 1 ? minRev - 1 : 0;
  const changes = await get(
    `/chat/private/rooms/${ROOM}/changes?since_revision=${since}&limit=100`
  );
  const changed = ((changes.items ?? []) as Row[]).filter(isCall);
  check(
    "/changes replays the call rows for a reconnecting client",
    changed.length > 0,
    `since_revision=${since} calls=${changed.length}`
  );
  check(
    "/changes carries the SETTLED call state, not the ringing one",
    changed.every(
      (m) =>
        String(m.content?.call?.callStatus ?? "").toUpperCase() !== "RINGING"
    ),
    changed.map((m) => m.content?.call?.callStatus).join(",")
  );

  // ---- inbox: the call is the conversation's last activity ------------------
  const inbox = await get(`/chat/inbox?limit=50`);
  const convs = (inbox.items ?? inbox.data ?? []) as Array<{
    roomId?: string;
    lastMessage?: { contentType?: string; content?: { text?: string } };
    lastMessageAt?: unknown;
    lastActivityAt?: unknown;
  }>;
  const row = convs.find((c) => c.roomId === ROOM);
  check("the called conversation is in the inbox", Boolean(row));
  check(
    "inbox lastMessage is the call",
    ["VOICE_CALL", "VIDEO_CALL"].includes(
      String(row?.lastMessage?.contentType ?? "").toUpperCase()
    ),
    String(row?.lastMessage?.contentType)
  );
  check(
    "inbox preview text is the call text",
    Boolean(row?.lastMessage?.content?.text),
    String(row?.lastMessage?.content?.text)
  );
  check(
    "the called conversation sorts first (latest activity)",
    convs[0]?.roomId === ROOM,
    `top=${convs[0]?.roomId}`
  );

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
