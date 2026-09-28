/**
 * Live probe: does an invitation decide the join from the community's CURRENT
 * privacy, or from the privacy that was in force when the link was minted?
 *
 * The reported failure is a card sent while the community was PUBLIC that still
 * walked the tapper straight in after the admin flipped the community to
 * PRIVATE. Every row below redeems a link whose community's privacy has (or has
 * not) moved underneath it and records which of `member` / `request` the redeem
 * answered with — the one fact that says whether the server read the link or the
 * community. The rest of the matrix (approve, reject, cancel, re-request, ban,
 * reset, already-member, duplicates) rides the same fixture so a fix for the
 * staleness cannot quietly break the ordinary flows around it.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> pnpm exec tsx \
 *     scripts/probe-invite-privacy-staleness.ts
 *
 * One run sits right at `community.invite-preview` (30 requests per 15 minutes
 * per IP, and it covers redeem as well as the preview), so a second run inside
 * the window spends most of its time in the 429 backoff below. Clear the dev
 * counters first to run it back to back:
 *
 *   rl:gw:community.invite-preview:<ip>          (gateway, IP-scoped)
 *   community:invite-rl:create:<userId>          (link creation, 20/hour/user)
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";

const API = process.env.GATEWAY_API ?? "http://localhost:3000/api/v1";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const CATEGORY = process.env.CATEGORY_ID ?? "6a0eac0496d4870f5cbf95bc";

const ADMIN = process.env.ADMIN_ID ?? "7b0db132-ffff-4d99-ab3c-421f83fba2ef";
const MOD = process.env.MOD_ID ?? "1b98aed5-cc15-41d6-95bb-bef47a44f063";
const REQUESTER = process.env.REQUESTER_ID ?? "246a48a1-8574-40c2-99c2-662343fedc4c";

if (!SECRET) {
  console.error("JWT_ACCESS_SECRET is required.");
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const tokenFor = (userId: string): string =>
  signAccessToken({ userId, sessionId: randomUUID(), secret: SECRET, expiresInSeconds: 7200 });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A full matrix run makes several hundred writes, which is more than the
 * gateway's global window allows — so a 429 is the probe outrunning the server,
 * not a verdict about the behaviour under test. Wait out the window the server
 * names and try again rather than reporting a rate limit as a failed row.
 */
async function api(
  user: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${tokenFor(user)}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status !== 429 || attempt >= 6) return { status: res.status, json };
    const retryAfter = Number(res.headers.get("retry-after") ?? json?.retryAfter ?? 0);
    const waitMs = Math.min(Math.max(retryAfter, 5) * 1000, 120_000);
    console.log(`  … rate limited on ${method} ${path}; waiting ${waitMs / 1000}s`);
    await sleep(waitMs);
  }
}

const suffix = (): string => Math.random().toString(36).slice(2, 8);

/**
 * A fresh community owned by ADMIN with MOD seated as a moderator.
 *
 * MOD is always seated because link creation is rate-limited PER USER: a full
 * matrix run mints more links than one account's hourly budget allows, so rows
 * that do not care who minted the link alternate between the two.
 */
async function makeCommunity(type: "PUBLIC" | "PRIVATE"): Promise<string> {
  const s = suffix();
  const res = await api(ADMIN, "POST", "/communities", {
    name: `StalePrivacy ${s}`,
    handle: `stalepriv${s}`,
    type,
    categoryId: CATEGORY,
  });
  const id = res.json?.data?.id ?? res.json?.data?.communityId;
  if (!id) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.json)}`);
  await api(ADMIN, "POST", `/communities/${id}/members`, { userIds: [MOD] });
  await api(ADMIN, "PUT", `/communities/${id}/members/${MOD}/role`, { role: "MODERATOR" });
  return id;
}

/** Round-robin for rows where the minter is irrelevant — see `makeCommunity`. */
let minterTurn = 0;
const anyMinter = (): string => (minterTurn++ % 2 === 0 ? ADMIN : MOD);

async function setType(id: string, type: "PUBLIC" | "PRIVATE"): Promise<void> {
  const r = await api(ADMIN, "PATCH", `/communities/${id}`, { type });
  if (r.status >= 400) throw new Error(`setType failed: ${r.status} ${JSON.stringify(r.json)}`);
}

/** Mint a link as `creator`, optionally flagged queue-skipping. */
async function makeLink(
  id: string,
  creator: string,
  autoApprove: boolean
): Promise<{ code: string; linkId: string }> {
  const r = await api(creator, "POST", `/communities/${id}/invite-links`, {
    maxUses: 100,
    autoApprove,
  });
  // An error envelope carries a `code` too — the ERROR code. Gate on the status
  // first or a rate-limited create silently hands back "…RATE_LIMITED" as if it
  // were an invite code, and every row after it fails for the wrong reason.
  const d = r.json?.data;
  if (r.status >= 300 || !d?.code) {
    throw new Error(`link failed: ${r.status} ${JSON.stringify(r.json)}`);
  }
  return { code: d.code, linkId: d.linkId };
}

/** What did the redeem actually do? */
async function redeem(code: string, user = REQUESTER): Promise<string> {
  const r = await api(user, "POST", `/communities/invite-links/${code}/redeem`, {});
  const d = r.json?.data ?? r.json;
  if (r.status >= 400) return `ERROR:${d?.code ?? r.json?.code ?? r.status}`;
  if (d?.member) return "MEMBER";
  if (d?.request) return "REQUEST";
  return `UNKNOWN:${JSON.stringify(d)}`;
}

/** The admin's view of who is still waiting. */
async function pendingRequests(id: string, userId = REQUESTER): Promise<any[]> {
  const r = await api(ADMIN, "GET", `/communities/${id}/join-requests?status=PENDING&limit=50`);
  const rows = r.json?.data?.data ?? [];
  return (Array.isArray(rows) ? rows : []).filter((x: any) => x.userId === userId);
}

async function isMember(id: string, userId = REQUESTER): Promise<boolean> {
  // limit maxes out at 50 — asking for more is a 400, not a bigger page.
  const r = await api(ADMIN, "GET", `/communities/${id}/members?limit=50`);
  const rows = r.json?.data?.data ?? [];
  return (Array.isArray(rows) ? rows : []).some(
    (m: any) => m.userId === userId && m.status === "ACTIVE"
  );
}

/** Undo the requester's state so the next row starts clean. */
async function reset(id: string): Promise<void> {
  await api(REQUESTER, "DELETE", `/communities/${id}/join-requests/mine`);
  await api(REQUESTER, "POST", `/communities/${id}/leave`, {});
}

async function main(): Promise<void> {
  // ── 1-6: the two transition directions, from both ends ───────────────────
  {
    const id = await makeCommunity("PUBLIC");
    const { code } = await makeLink(id, anyMinter(), false);
    check("1  PUBLIC link, still PUBLIC → direct join", (await redeem(code)) === "MEMBER");
    await reset(id);
  }
  {
    const id = await makeCommunity("PUBLIC");
    const { code } = await makeLink(id, anyMinter(), false);
    await setType(id, "PRIVATE");
    const got = await redeem(code);
    check("2  PUBLIC link, now PRIVATE → request", got === "REQUEST", got);
    check("2b no membership was created", !(await isMember(id)));
    await reset(id);
  }
  {
    const id = await makeCommunity("PRIVATE");
    const { code } = await makeLink(id, anyMinter(), false);
    const got = await redeem(code);
    check("3  PRIVATE link, still PRIVATE → request", got === "REQUEST", got);
    await reset(id);
  }
  {
    const id = await makeCommunity("PRIVATE");
    const { code } = await makeLink(id, anyMinter(), false);
    await setType(id, "PUBLIC");
    const got = await redeem(code);
    check("4  PRIVATE link, now PUBLIC → direct join", got === "MEMBER", got);
    await reset(id);
  }
  // 5/6 are the stale-client cases: the card was RENDERED under the old privacy
  // (a preview read), and the privacy moves before the tap.
  {
    const id = await makeCommunity("PUBLIC");
    const { code } = await makeLink(id, anyMinter(), false);
    const preview = await api(REQUESTER, "GET", `/communities/invite-links/${code}`);
    check("5a preview read PUBLIC", preview.json?.data?.communityType === "PUBLIC");
    await setType(id, "PRIVATE");
    const got = await redeem(code);
    check("5  card rendered PUBLIC, tapped once PRIVATE → request", got === "REQUEST", got);
    await reset(id);
  }
  {
    const id = await makeCommunity("PRIVATE");
    const { code } = await makeLink(id, anyMinter(), false);
    const preview = await api(REQUESTER, "GET", `/communities/invite-links/${code}`);
    check("6a preview read PRIVATE", preview.json?.data?.communityType === "PRIVATE");
    await setType(id, "PUBLIC");
    const got = await redeem(code);
    check("6  card rendered PRIVATE, tapped once PUBLIC → direct join", got === "MEMBER", got);
    await reset(id);
  }

  // ── the reported bug: `autoApprove` is the stale privacy in disguise ──────
  {
    const id = await makeCommunity("PUBLIC");
    const { code } = await makeLink(id, ADMIN, true);
    await setType(id, "PRIVATE");
    const got = await redeem(code);
    check("7  admin auto-approve link minted PUBLIC, now PRIVATE → request", got === "REQUEST", got);
    check("7b no membership was created", !(await isMember(id)));
    await reset(id);
  }
  {
    const id = await makeCommunity("PUBLIC");
    const { code } = await makeLink(id, MOD, true);
    await setType(id, "PRIVATE");
    const got = await redeem(code);
    check("8  moderator auto-approve link minted PUBLIC, now PRIVATE → request", got === "REQUEST", got);
    await reset(id);
  }
  {
    const id = await makeCommunity("PRIVATE");
    const { code } = await makeLink(id, ADMIN, true);
    const got = await redeem(code);
    check("9  auto-approve link minted PRIVATE → request", got === "REQUEST", got);
    await reset(id);
  }

  // ── approve / reject / cancel / re-request ───────────────────────────────
  {
    const id = await makeCommunity("PRIVATE");
    const { code } = await makeLink(id, anyMinter(), false);
    await redeem(code);
    const [row] = await pendingRequests(id);
    check("10a request is pending and no membership yet", Boolean(row) && !(await isMember(id)));
    await api(ADMIN, "POST", `/communities/${id}/join-requests/${row.requestId ?? row.id}/approve`, {});
    check("10 admin approves → member", await isMember(id));
    check("10b nothing left pending", (await pendingRequests(id)).length === 0);
    await reset(id);
  }
  {
    const id = await makeCommunity("PRIVATE");
    const { code } = await makeLink(id, anyMinter(), false);
    await redeem(code);
    const [row] = await pendingRequests(id);
    await api(ADMIN, "POST", `/communities/${id}/join-requests/${row.requestId ?? row.id}/reject`, {});
    check("11 admin rejects → no membership", !(await isMember(id)));
    check("11b nothing left pending", (await pendingRequests(id)).length === 0);
    await reset(id);
  }
  {
    const id = await makeCommunity("PRIVATE");
    const { code } = await makeLink(id, anyMinter(), false);
    await redeem(code);
    const cancel = await api(REQUESTER, "DELETE", `/communities/${id}/join-requests/mine`);
    check("12 requester cancels → no membership, nothing pending",
      cancel.status < 300 && !(await isMember(id)) && (await pendingRequests(id)).length === 0,
      `status=${cancel.status}`);
    const again = await redeem(code);
    check("13 re-request after cancel works", again === "REQUEST" && (await pendingRequests(id)).length === 1, again);
    await reset(id);
  }

  // ── duplicates, already-member, ban ──────────────────────────────────────
  {
    const id = await makeCommunity("PRIVATE");
    const { code } = await makeLink(id, anyMinter(), false);
    await redeem(code);
    const second = await redeem(code);
    check("14 double tap → one PENDING request", second === "REQUEST" && (await pendingRequests(id)).length === 1, second);
    await reset(id);
  }
  {
    const id = await makeCommunity("PUBLIC");
    const { code } = await makeLink(id, anyMinter(), false);
    await redeem(code);
    const second = await redeem(code);
    check("15 already a member → idempotent member, no request",
      second === "MEMBER" && (await pendingRequests(id)).length === 0, second);
    await setType(id, "PRIVATE");
    check("16 PUBLIC → PRIVATE keeps the existing member", await isMember(id));
    const third = await redeem(code);
    check("16b the member's card still resolves to member", third === "MEMBER", third);
    await reset(id);
  }
  {
    const id = await makeCommunity("PUBLIC");
    const { code } = await makeLink(id, anyMinter(), false);
    await redeem(code);
    await api(ADMIN, "POST", `/communities/${id}/members/${REQUESTER}/ban`, { reason: "probe" });
    await setType(id, "PRIVATE");
    const got = await redeem(code);
    check("17 a banned user cannot redeem past the ban", got.startsWith("ERROR:"), got);
    check("17b and files no request", (await pendingRequests(id)).length === 0);
  }

  // ── reset link ───────────────────────────────────────────────────────────
  {
    const id = await makeCommunity("PUBLIC");
    const old = await makeLink(id, anyMinter(), false);
    await api(ADMIN, "DELETE", `/communities/${id}/invite-links/${old.linkId}`);
    const dead = await redeem(old.code);
    check("18 the reset link is refused", dead.startsWith("ERROR:"), dead);
    const fresh = await makeLink(id, anyMinter(), false);
    check("19 the new link works under current PUBLIC", (await redeem(fresh.code)) === "MEMBER");
    await reset(id);
    await setType(id, "PRIVATE");
    const afterFlip = await redeem(fresh.code);
    check("20 the new link follows the CURRENT privacy after a flip", afterFlip === "REQUEST", afterFlip);
    await reset(id);
  }

  // ── only the ADMIN is asked to approve; moderators are not ───────────────
  {
    const id = await makeCommunity("PRIVATE");
    const { code } = await makeLink(id, anyMinter(), false);
    await redeem(code);
    // The community id rides `groupKey` ("community:<id>:join_request:<user>"),
    // not a top-level field.
    const notifs = async (u: string) => {
      const r = await api(u, "GET", "/chat/notifications?limit=30");
      return (r.json?.data?.data ?? []).filter(
        (n: any) =>
          n.type === "community.join_requested" &&
          String(n.groupKey ?? "").includes(id)
      );
    };
    // The notification travels over RabbitMQ, so it lands a beat after the
    // request does — poll rather than read once and call it missing.
    let adminRows: any[] = [];
    for (let i = 0; i < 15 && adminRows.length === 0; i += 1) {
      adminRows = await notifs(ADMIN);
      if (adminRows.length === 0) await sleep(1000);
    }
    check("21 the admin is notified of the join request", adminRows.length === 1, `rows=${adminRows.length}`);
    check("22 the moderator is NOT", (await notifs(MOD)).length === 0);
    await reset(id);
  }

  // ── the reported surface: the invitation CARD sitting in a DM ────────────
  // Everything above exercises the redeem endpoint directly. This drives the
  // shape the bug was actually reported in — a card an admin sent into a
  // conversation while the community was open, tapped after it closed.
  {
    const id = await makeCommunity("PUBLIC");
    const send = await api(ADMIN, "POST", `/communities/${id}/invite-links/bulk-send`, {
      userIds: [REQUESTER],
    });
    check("23 the admin sends the invitation card into the DM", send.status < 300, `status=${send.status}`);

    await setType(id, "PRIVATE");

    // Read the card back the way the client does: the DM's message history,
    // which re-resolves the invitation on every read.
    const room = await api(REQUESTER, "GET", `/chat/private/rooms/${ADMIN}`);
    const roomId = room.json?.data?.roomId ?? room.json?.data?.room?.roomId;
    const history = await api(REQUESTER, "GET", `/chat/private/rooms/${roomId}/messages?limit=20`);
    const rows: any[] = history.json?.data?.data ?? history.json?.data?.messages ?? [];
    const card = rows
      .map((m) => m?.content?.invitation ?? m?.systemAction)
      .find((c: any) => c?.type === "COMMUNITY_INVITATION" && c?.communityId === id);

    check("24 the card is found in the conversation", Boolean(card), `roomId=${roomId} rows=${rows.length}`);
    check("25 the card reports the CURRENT privacy, not the one it was sent under",
      card?.communityType === "PRIVATE", `communityType=${card?.communityType}`);
    check("26 the card shows neither membership nor a pending request",
      card?.alreadyJoined === false && !card?.joinRequestPending,
      `joined=${card?.alreadyJoined} pending=${card?.joinRequestPending}`);

    // Tapping it is the reported click.
    const tapped = await redeem(String(card?.inviteCode ?? ""));
    check("27 tapping the stale card files a request", tapped === "REQUEST", tapped);
    check("28 and creates no membership", !(await isMember(id)));

    // The admin approves, and only then is the user in.
    const [row] = await pendingRequests(id);
    await api(ADMIN, "POST", `/communities/${id}/join-requests/${row?.requestId}/approve`, {});
    check("29 after approval the user is a member", await isMember(id));

    const after = await api(REQUESTER, "GET", `/chat/private/rooms/${roomId}/messages?limit=20`);
    const afterRows: any[] = after.json?.data?.data ?? after.json?.data?.messages ?? [];
    const afterCard = afterRows
      .map((m) => m?.content?.invitation ?? m?.systemAction)
      .find((c: any) => c?.type === "COMMUNITY_INVITATION" && c?.communityId === id);
    check("30 the card now reads as a membership (View Community)",
      afterCard?.alreadyJoined === true && !afterCard?.joinRequestPending,
      `joined=${afterCard?.alreadyJoined} pending=${afterCard?.joinRequestPending}`);
    await reset(id);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
