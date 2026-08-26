/**
 * LIVE end-to-end verification of the group join limits against a running
 * chat-service (real Mongo, real Redis) — no mocks anywhere.
 *
 * Two "sessions" for the joining user are modelled as two independent Redis
 * subscribers on that user's own `user:<id>` channel: that channel IS what every
 * gateway socket for the user is fed from, so both receiving `group:added` is
 * the cross-session flip (scenario D1) proven on the wire.
 */
import { signAccessToken } from "@aimess/auth-jwt";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";

const BASE = "http://127.0.0.1:3004/api/chat";
const SECRET = process.env.JWT_ACCESS_SECRET;
if (!SECRET) throw new Error("JWT_ACCESS_SECRET missing");

const tok = (userId, sessionId = randomUUID()) =>
  signAccessToken({ userId, sessionId, secret: SECRET, expiresInSeconds: 3600 });

const ADMIN = randomUUID();
const JOINER = randomUUID();
const OUTSIDER = randomUUID();

const adminTok = tok(ADMIN);
const joinerSessionA = tok(JOINER);
const joinerSessionB = tok(JOINER); // same user, different session id
const outsiderTok = tok(OUTSIDER);

async function call(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: json };
}

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail}`);
}

const redisOpts = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
};

async function main() {
  // --- two sessions of the SAME user, listening on their personal channel ---
  const subA = new Redis(redisOpts);
  const subB = new Redis(redisOpts);
  const seenA = [];
  const seenB = [];
  const record = (sink) => (_ch, raw) => {
    try {
      sink.push(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  };
  subA.on("message", record(seenA));
  subB.on("message", record(seenB));
  await subA.subscribe(`user:${JOINER}`);
  await subB.subscribe(`user:${JOINER}`);

  // --- seed: admin creates a group, then mints an invite link ---
  const group = await call("POST", "/groups", adminTok, {
    name: `live-verify-${Date.now()}`,
    description: "",
  });
  if (group.status !== 201 && group.status !== 200) {
    console.log("group create failed", group.status, JSON.stringify(group.body));
    process.exit(1);
  }
  const roomId = group.body.data.roomId ?? group.body.data.room?.roomId;
  const link = await call("POST", "/invite-links", adminTok, { roomId });
  const token = link.body.data.token;
  console.log(`\nseeded room=${roomId} token=${token}\n`);

  // --- C1: codes are unique per mint (never reused) ---
  const link2 = await call("POST", "/invite-links", adminTok, { roomId });
  check(
    "C1-unique-codes",
    link2.body.data.token !== token,
    `${token} != ${link2.body.data.token}`
  );

  // --- A/F: a non-member sees CAN_JOIN on a live link ---
  let pv = await call("GET", `/invite-links/preview/${token}`, joinerSessionA);
  check("A1-preview-can-join", pv.body?.data?.state === "CAN_JOIN", `state=${pv.body?.data?.state}`);

  // --- D1: session A joins; BOTH sessions must hear group:added ---
  const joined = await call("POST", "/invite-links/join", joinerSessionA, { token });
  check("join-200", joined.status === 200, `status=${joined.status}`);
  await new Promise((r) => setTimeout(r, 1200));
  const gotA = seenA.find((e) => e.event === "group:added" && e.data?.roomId === roomId);
  const gotB = seenB.find((e) => e.event === "group:added" && e.data?.roomId === roomId);
  check("D1-session-A-flip", !!gotA, gotA ? "group:added received" : "no event");
  check("D1-session-B-flip", !!gotB, gotB ? "group:added received" : "no event");
  check(
    "D5-no-cross-contamination",
    seenA.every((e) => !e.data?.roomId || e.data.roomId === roomId),
    "every event names this room only"
  );

  // --- D6/F1: hard re-read gives the same answer, server-derived ---
  pv = await call("GET", `/invite-links/preview/${token}`, joinerSessionB);
  check(
    "D6-reload-already-member",
    pv.body?.data?.state === "ALREADY_MEMBER" && pv.body?.data?.isJoined === true,
    `state=${pv.body?.data?.state}`
  );

  // --- E: joining again is a conflict, not a silent second membership ---
  const again = await call("POST", "/invite-links/join", joinerSessionA, { token });
  check("already-member-409", again.status === 409, `status=${again.status}`);

  // --- B6: a voluntary leaver may come back on the SAME link (done BEFORE the
  //         kick, so the two removal kinds are compared on the same account) ---
  const left = await call("POST", `/group-members/${roomId}/leave`, joinerSessionA, {});
  check("B6-leave", left.status === 200, `status=${left.status}`);
  pv = await call("GET", `/invite-links/preview/${token}`, joinerSessionA);
  check("B6-can-rejoin", pv.body?.data?.state === "CAN_JOIN", `state=${pv.body?.data?.state}`);
  const rejoin = await call("POST", "/invite-links/join", joinerSessionA, { token });
  check("B6-rejoin-200", rejoin.status === 200, `status=${rejoin.status}`);

  // --- B1/B7: admin removes the joiner → the link stops working for them ---
  const kicked = await call("POST", "/group-members/kick", adminTok, {
    roomId,
    userId: JOINER,
  });
  check("kick-200", kicked.status === 200, `status=${kicked.status}`);
  await new Promise((r) => setTimeout(r, 800));
  // LAST one: this session already saw the voluntary LEAVE above.
  const removals = (sink) =>
    sink.filter((e) => e.event === "group:removed" && e.data?.roomId === roomId);
  const removedA = removals(seenA).at(-1);
  const removedB = removals(seenB).at(-1);
  check(
    "D3-removal-reaches-both-sessions",
    !!removedA && !!removedB && removedA.data.reason === "KICK",
    `reason=${removedA?.data?.reason}`
  );

  pv = await call("GET", `/invite-links/preview/${token}`, joinerSessionA);
  check("B1-preview-blocked", pv.body?.data?.state === "JOIN_BLOCKED", `state=${pv.body?.data?.state}`);
  const blockedJoin = await call("POST", "/invite-links/join", joinerSessionA, { token });
  check(
    "B1-join-refused",
    blockedJoin.status === 403 && blockedJoin.body?.code === "CHAT_JOIN_BLOCKED",
    `status=${blockedJoin.status} code=${blockedJoin.body?.code}`
  );

  // --- B4: a brand-new link is no bypass ---
  const fresh = await call("POST", "/invite-links", adminTok, { roomId });
  const freshToken = fresh.body.data.token;
  const freshJoin = await call("POST", "/invite-links/join", joinerSessionA, {
    token: freshToken,
  });
  check(
    "B4-fresh-link-still-blocked",
    freshJoin.status === 403,
    `status=${freshJoin.status}`
  );

  // --- B5: an ADMIN's manual add is the ONE key to the block. These synthetic
  //         users are not friends, so the add is stopped by the PRE-EXISTING
  //         friend gate that guards every direct add — the point here is that it
  //         got PAST the rejoin block to reach it (CHAT_ADD_MEMBER_NOT_FRIEND,
  //         not CHAT_JOIN_BLOCKED / CHAT_BANNED_FROM_ROOM). The full re-add is
  //         covered by tests/groups/group-roster-realtime.test.ts.
  const readd = await call("POST", "/group-members/add", adminTok, {
    roomId,
    userId: JOINER,
  });
  check(
    "B5-block-yields-to-admin-add",
    readd.body?.code === "CHAT_ADD_MEMBER_NOT_FRIEND",
    `code=${readd.body?.code} (friend gate, i.e. the rejoin block let it through)`
  );

  // --- C: revoke rotates the code; the old token is dead everywhere ---
  const revoke = await call("POST", "/invite-links/revoke", adminTok, {
    token: freshToken,
  });
  check(
    "C1-revoke-rotates",
    revoke.status === 200 && revoke.body?.data?.link?.token && revoke.body.data.link.token !== freshToken,
    `new=${revoke.body?.data?.link?.token}`
  );
  const deadPreview = await call("GET", `/invite-links/preview/${freshToken}`, outsiderTok);
  check(
    "C2-old-link-expired",
    deadPreview.status === 400 && deadPreview.body?.code === "CHAT_INVITE_LINK_EXPIRED",
    `status=${deadPreview.status} code=${deadPreview.body?.code} msg=${deadPreview.body?.message}`
  );
  const deadJoin = await call("POST", "/invite-links/join", outsiderTok, {
    token: freshToken,
  });
  check(
    "C5-old-link-join-refused",
    deadJoin.status === 400 && deadJoin.body?.code === "CHAT_INVITE_LINK_EXPIRED",
    `status=${deadJoin.status} code=${deadJoin.body?.code}`
  );
  const newToken = revoke.body.data.link.token;
  const newPreview = await call("GET", `/invite-links/preview/${newToken}`, outsiderTok);
  check(
    "C8-new-link-works",
    newPreview.status === 200 && newPreview.body?.data?.state === "CAN_JOIN",
    `state=${newPreview.body?.data?.state}`
  );

  // --- E6: a non-admin cannot revoke ---
  const badRevoke = await call("POST", "/invite-links/revoke", joinerSessionA, {
    token: newToken,
  });
  check("E6-non-admin-revoke-refused", badRevoke.status >= 400, `status=${badRevoke.status}`);

  // -------------------------------------------------------------------------
  // A. Capacity, at a REAL boundary. `memberLimit` 2 exercises the identical
  // atomic reservation the 256 cap uses (`reserveMemberSlot`), without seeding
  // 255 rows — the primitive does not care what the number is.
  // -------------------------------------------------------------------------
  const small = await call("POST", "/groups", adminTok, {
    name: `live-cap-${Date.now()}`,
    memberLimit: 2,
  });
  const capRoom = small.body.data.roomId ?? small.body.data.room?.roomId;
  const capLink = (await call("POST", "/invite-links", adminTok, { roomId: capRoom }))
    .body.data.token;

  // A8/E5: the platform cap cannot be raised, by anyone, through any payload.
  const raise = await call("PATCH", `/groups/rooms/${capRoom}`, adminTok, {
    memberLimit: 5000,
  });
  check("A8-cap-cannot-be-raised", raise.status === 400, `status=${raise.status}`);

  // A7/E4: four users race for the ONE remaining slot.
  const racers = Array.from({ length: 4 }, () => tok(randomUUID()));
  const raced = await Promise.all(
    racers.map((t) => call("POST", "/invite-links/join", t, { token: capLink }))
  );
  const won = raced.filter((r) => r.status === 200).length;
  const full = raced.filter(
    (r) => r.status === 400 && r.body?.code === "CHAT_GROUP_MEMBER_LIMIT_REACHED"
  ).length;
  check("A7-exactly-one-winner", won === 1, `winners=${won}`);
  check("A7-others-see-group-full", full === 3, `refused=${full}`);

  // A2/A3: the group now reads FULL on the preview, authed and anonymous alike.
  const fullPreview = await call("GET", `/invite-links/preview/${capLink}`, tok(randomUUID()));
  check("A2-preview-group-full", fullPreview.body?.data?.state === "GROUP_FULL", `state=${fullPreview.body?.data?.state}`);
  const anonPreview = await call("GET", `/invite-links/preview/${capLink}`, null);
  check("A3-anonymous-group-full", anonPreview.body?.data?.state === "GROUP_FULL", `state=${anonPreview.body?.data?.state}`);
  check(
    "A11-count-is-server-truth",
    fullPreview.body?.data?.memberCount === 2 && fullPreview.body?.data?.memberLimit === 2,
    `count=${fullPreview.body?.data?.memberCount}/${fullPreview.body?.data?.memberLimit}`
  );

  // A5: the admin removes the winner — capacity frees and the state reverts.
  const winnerIdx = raced.findIndex((r) => r.status === 200);
  const members = await call("GET", `/group-members/${capRoom}`, adminTok);
  const kickTarget = (members.body?.data?.data ?? members.body?.data ?? []).find(
    (m) => m.userId !== ADMIN && m.role !== "ADMIN"
  );
  const freed = await call("POST", "/group-members/kick", adminTok, {
    roomId: capRoom,
    userId: kickTarget?.userId,
  });
  check("A5-remove-member", freed.status === 200, `status=${freed.status} target=${kickTarget?.userId}`);
  const freedPreview = await call("GET", `/invite-links/preview/${capLink}`, tok(randomUUID()));
  check(
    "A4/A5-reverts-to-can-join",
    freedPreview.body?.data?.state === "CAN_JOIN",
    `state=${freedPreview.body?.data?.state} count=${freedPreview.body?.data?.memberCount} (winner idx ${winnerIdx})`
  );

  await subA.quit();
  await subB.quit();

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} live checks passed` +
      (failed.length ? `\nFAILED: ${failed.map((f) => f.id).join(", ")}` : "")
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
