/**
 * END-TO-END verification of the five privacy settings against a RUNNING stack
 * (api-gateway + auth-service + user-service + chat-service).
 *
 * The Jest suites mock repositories and the other verify-* scripts stop at the
 * SQL / gRPC boundary. This one drives real HTTP through the gateway with real
 * JWTs, so it is the only check that proves a setting is actually enforced on
 * the wire — including the surfaces that live in a different service from the
 * setting itself (presence lives in chat-service, the scope in user-service).
 *
 * Creates three throwaway accounts (prefix `zzpriv_`) and leaves them behind —
 * registration is not transactional across services, so there is nothing safe
 * to roll back. They are inert: no friends, no rooms, no messages.
 *
 *   BASE_URL=http://localhost:3000 npx tsx scripts/verify-privacy-e2e.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
   A probe script that asserts on raw API JSON; declaring every response shape
   would add ceremony, not safety. */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PASSWORD = "PrivacyProbe!2026";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
}

type Json = Record<string, any>;

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let body: Json;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

type Actor = { account: string; userId: string; token: string };

/** Register + login one throwaway account and return its access token. */
async function makeActor(suffix: string): Promise<Actor> {
  const account = `zzpriv_${suffix}_${Date.now().toString(36)}`;
  const reg = await api("POST", "/api/v1/auth/register", {
    body: { account, password: PASSWORD },
  });
  if (reg.status >= 300) {
    throw new Error(
      `register ${account} failed: ${reg.status} ${JSON.stringify(reg.body)}`
    );
  }
  const data = reg.body.data ?? reg.body;
  const token = data.accessToken ?? data.tokens?.accessToken;
  const userId = data.userId ?? data.user?.id ?? data.user?.userId;
  if (!token || !userId) {
    throw new Error(
      `register ${account}: no token/userId in ${JSON.stringify(data)}`
    );
  }
  // The user_profiles row (which search, presence and profile reads all key
  // off) is created asynchronously by user-service's user-created consumer, so
  // the PATCH has to wait for the event to land rather than assume it has.
  let profile: { status: number; body: Json } | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    profile = await api("PATCH", "/api/v1/users/profiles/me", {
      token,
      body: {
        firstName: "Privacy",
        lastName: "Probe",
        username: account.toLowerCase().replace(/-/g, "_"),
        dateOfBirth: "1995-06-15",
        gender: "MALE",
      },
    });
    if (profile.status < 300) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!profile || profile.status >= 300) {
    throw new Error(
      `profile ${account} failed: ${profile?.status} ${JSON.stringify(profile?.body)}`
    );
  }
  return { account: account.toLowerCase().replace(/-/g, "_"), userId, token };
}

/** PATCH one privacy field for `actor`. */
async function setPrivacy(actor: Actor, patch: Json) {
  const res = await api("PATCH", "/api/v1/users/settings/me", {
    token: actor.token,
    body: { privacy: patch },
  });
  if (res.status >= 300) {
    throw new Error(
      `PATCH settings ${JSON.stringify(patch)} → ${res.status} ${JSON.stringify(res.body)}`
    );
  }
  return res.body;
}

/** Does `viewer` find `target` by username search? */
async function canFind(viewer: Actor, target: Actor): Promise<boolean> {
  const res = await api(
    "GET",
    `/api/v1/users/search?q=${encodeURIComponent(target.account)}`,
    { token: viewer.token }
  );
  const payload = JSON.stringify(res.body);
  return payload.includes(target.userId);
}

/**
 * Open a real `/chat` socket so the subject is genuinely ONLINE, and keep it
 * heartbeating. Returns null if socket.io-client isn't resolvable or the
 * handshake fails — the caller then reports the probe as unproven rather than
 * silently passing.
 */
async function connectSocket(
  token: string
): Promise<{ disconnect(): void } | null> {
  try {
    // socket.io-client is not a user-service dependency; it lives in the
    // workspace store for the gateway/testing tooling. Try the bare specifier
    // first, then the hoisted pnpm path.
    const mod: any = await import("socket.io-client").catch(
      () =>
        import("../../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm/index.js")
    );
    const io = mod.io ?? mod.default?.io ?? mod.default;
    const socket = io(`${BASE}/chat`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });
    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      socket.on("connect", () => {
        clearTimeout(timer);
        resolve(true);
      });
      socket.on("connect_error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (!connected) return null;
    socket.emit("presence:heartbeat", { appState: "FOREGROUND" });
    const beat = setInterval(
      () => socket.emit("presence:heartbeat", { appState: "FOREGROUND" }),
      2000
    );
    return {
      disconnect() {
        clearInterval(beat);
        socket.disconnect();
      },
    };
  } catch {
    return null;
  }
}

/**
 * Read presence until it matches `expected` (or time out). Presence is derived
 * from Redis device sessions written by the socket, so it is eventually — not
 * immediately — consistent with the connect/heartbeat.
 */
async function pollPresence(
  viewer: Actor,
  subjectId: string,
  expected: boolean
): Promise<boolean | undefined> {
  let last: boolean | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await api("GET", `/api/v1/chat/private/presence/${subjectId}`, {
      token: viewer.token,
    });
    last = res.body?.data?.isOnline;
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

/**
 * Subscribe `watcher` to `subject`'s presence, flip the subject online/offline
 * once while the scope still allows it (positive control), then tighten the
 * scope to NO_ONE and flip again — the second flip must reach nobody.
 */
async function probeSubscriptionRevocation(
  subject: Actor,
  watcher: Actor
): Promise<{ beforeChange?: boolean; afterChange?: boolean }> {
  const mod: any = await import("socket.io-client").catch(
    () =>
      import("../../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm/index.js")
  );
  const io = mod.io ?? mod.default?.io ?? mod.default;
  if (!io) return {};

  const watcherSocket = io(`${BASE}/chat`, {
    auth: { token: watcher.token },
    transports: ["websocket"],
    reconnection: false,
  });
  await new Promise<void>((resolve) => {
    watcherSocket.on("connect", () => resolve());
    watcherSocket.on("connect_error", () => resolve());
    setTimeout(resolve, 8000);
  });

  let received = false;
  watcherSocket.on("presence:status", () => {
    received = true;
  });
  await new Promise<void>((resolve) => {
    watcherSocket.emit(
      "presence:subscribe",
      { peerIds: [subject.userId] },
      () => resolve()
    );
    setTimeout(resolve, 3000);
  });

  /** One online→offline round trip for the subject; returns whether it was heard. */
  const flip = async (): Promise<boolean> => {
    received = false;
    const s = await connectSocket(subject.token);
    await new Promise((r) => setTimeout(r, 2500));
    s?.disconnect();
    await new Promise((r) => setTimeout(r, 3000));
    return received;
  };

  const beforeChange = await flip();
  await setPrivacy(subject, { whoCanSeeOnlineStatus: "NO_ONE" });
  // Give the revocation (published on user:<subject>, applied by the gateway)
  // a moment to land before the second flip.
  await new Promise((r) => setTimeout(r, 1500));
  const afterChange = await flip();

  watcherSocket.disconnect();
  return { beforeChange, afterChange };
}

/** Pull one USER row out of the unified-search payload, whichever bucket it landed in. */
function findUserRow(body: Json, userId: string): Json | null {
  const buckets = [body?.data?.recent, body?.data?.chat, body?.data?.other];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    const hit = bucket.find(
      (item: Json) => item?.type === "USER" && item?.userId === userId
    );
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.log(`SKIP  no stack at ${BASE} — start the services, then re-run.`);
    process.exitCode = 0;
    return;
  }

  const subject = await makeActor("subject");
  const stranger = await makeActor("stranger");

  // --- 1. whoCanFindMe -----------------------------------------------------
  await setPrivacy(subject, { whoCanFindMe: "EVERYONE" });
  check(
    "whoCanFindMe=EVERYONE → a stranger finds the subject in search",
    await canFind(stranger, subject)
  );

  await setPrivacy(subject, { whoCanFindMe: "NO_ONE" });
  check(
    "whoCanFindMe=NO_ONE → the subject disappears from search",
    !(await canFind(stranger, subject))
  );

  // `whoCanFindMe` deliberately offers no plain FRIENDS option — the middle
  // rung is FRIENDS_OF_FRIENDS, and a stranger shares no mutual friend.
  await setPrivacy(subject, { whoCanFindMe: "FRIENDS_OF_FRIENDS" });
  check(
    "whoCanFindMe=FRIENDS_OF_FRIENDS → a viewer with no mutual friend cannot find the subject",
    !(await canFind(stranger, subject))
  );
  // Restore so the later probes are not confounded by discovery.
  await setPrivacy(subject, { whoCanFindMe: "EVERYONE" });

  // --- 2. whoCanSendFriendRequests ----------------------------------------
  await setPrivacy(subject, { whoCanSendFriendRequests: "NO_ONE" });
  const blockedReq = await api("POST", "/api/v1/users/friends/requests", {
    token: stranger.token,
    body: { addresseeId: subject.userId },
  });
  check(
    "whoCanSendFriendRequests=NO_ONE → a direct API call is REJECTED",
    blockedReq.status >= 400,
    `status ${blockedReq.status} ${JSON.stringify(blockedReq.body).slice(0, 160)}`
  );

  await setPrivacy(subject, { whoCanSendFriendRequests: "EVERYONE" });
  const allowedReq = await api("POST", "/api/v1/users/friends/requests", {
    token: stranger.token,
    body: { addresseeId: subject.userId },
  });
  check(
    "whoCanSendFriendRequests=EVERYONE → the same call is ACCEPTED",
    allowedReq.status < 300,
    `status ${allowedReq.status} ${JSON.stringify(allowedReq.body).slice(0, 160)}`
  );

  // --- 3. whoCanSeeOnlineStatus (cross-service: chat-service presence) -----
  await setPrivacy(subject, { whoCanSeeOnlineStatus: "NO_ONE" });
  const hidden = await api(
    "GET",
    `/api/v1/chat/private/presence/${subject.userId}`,
    { token: stranger.token }
  );
  check(
    "whoCanSeeOnlineStatus=NO_ONE → REST presence reports offline, lastSeen null",
    hidden.status === 200 &&
      hidden.body?.data?.isOnline === false &&
      hidden.body?.data?.lastSeen === null,
    `status ${hidden.status} ${JSON.stringify(hidden.body?.data)}`
  );

  const selfPresence = await api(
    "GET",
    `/api/v1/chat/private/presence/${subject.userId}`,
    { token: subject.token }
  );
  check(
    "the subject can still read their OWN presence under NO_ONE",
    selfPresence.status === 200,
    `status ${selfPresence.status}`
  );

  // A genuinely-online subject is what makes the two branches distinguishable:
  // without a live socket both scopes return isOnline:false and the NO_ONE
  // check above would pass even with the gate removed.
  const socket = await connectSocket(subject.token);
  if (socket) {
    await setPrivacy(subject, { whoCanSeeOnlineStatus: "EVERYONE" });
    const seenByStranger = await pollPresence(stranger, subject.userId, true);
    check(
      "whoCanSeeOnlineStatus=EVERYONE → a stranger sees the LIVE subject as online",
      seenByStranger === true,
      `isOnline=${seenByStranger}`
    );

    await setPrivacy(subject, { whoCanSeeOnlineStatus: "NO_ONE" });
    const hiddenWhileOnline = await pollPresence(
      stranger,
      subject.userId,
      false
    );
    check(
      "whoCanSeeOnlineStatus=NO_ONE → the SAME live subject reads as offline (the decisive case)",
      hiddenWhileOnline === false,
      `isOnline=${hiddenWhileOnline}`
    );

    const selfWhileOnline = await pollPresence(subject, subject.userId, true);
    check(
      "the subject still sees themself online under NO_ONE (isSelf always admits)",
      selfWhileOnline === true,
      `isOnline=${selfWhileOnline}`
    );

    socket.disconnect();
  } else {
    check(
      "live-socket presence probe",
      false,
      "socket.io-client connection failed — could not distinguish gated from offline"
    );
  }
  await setPrivacy(subject, { whoCanSeeOnlineStatus: "EVERYONE" });

  // --- 4. whoCanViewProfile ------------------------------------------------
  await setPrivacy(subject, { whoCanViewProfile: "NO_ONE" });
  const gatedProfile = await api("GET", `/api/v1/users/${subject.userId}`, {
    token: stranger.token,
  });
  const gated = gatedProfile.body?.data ?? {};
  check(
    "whoCanViewProfile=NO_ONE → gated fields are nulled for a stranger",
    gatedProfile.status < 400 &&
      gated.bio == null &&
      gated.friendsCount == null,
    `status ${gatedProfile.status} bio=${JSON.stringify(gated.bio)} friendsCount=${JSON.stringify(gated.friendsCount)}`
  );

  check(
    "whoCanViewProfile=NO_ONE → identity survives: name, avatar and username",
    gated.firstName !== null &&
      gated.displayName !== null &&
      typeof gated.username === "string" &&
      gated.username.length > 0,
    `displayName=${JSON.stringify(gated.displayName)} avatarUrl=${JSON.stringify(gated.avatarUrl)} username=${JSON.stringify(gated.username)}`
  );

  const gatedSearch = await api(
    "GET",
    `/api/v1/users/search?q=${encodeURIComponent(subject.account)}`,
    { token: stranger.token }
  );
  const gatedRow = JSON.stringify(gatedSearch.body).includes(subject.userId)
    ? findUserRow(gatedSearch.body, subject.userId)
    : null;
  // The scope gates CONTENT, not identity — the search row a stranger gets must
  // carry the same name and photo a friend sees, or the result is unusable.
  check(
    "the search row keeps the real name under NO_ONE, same as a friend's view",
    gatedRow !== null &&
      gatedRow.firstName === "Privacy" &&
      gatedRow.fullName !== null,
    gatedRow ? JSON.stringify(gatedRow).slice(0, 160) : "row not found"
  );

  await setPrivacy(subject, { whoCanViewProfile: "EVERYONE" });
  const openProfile = await api("GET", `/api/v1/users/${subject.userId}`, {
    token: stranger.token,
  });
  check(
    "whoCanViewProfile=EVERYONE → the real name comes back (positive control)",
    (openProfile.body?.data ?? {}).firstName === "Privacy",
    `firstName=${JSON.stringify(openProfile.body?.data?.firstName)}`
  );
  await setPrivacy(subject, { whoCanViewProfile: "NO_ONE" });

  const ownProfile = await api("GET", `/api/v1/users/${subject.userId}`, {
    token: subject.token,
  });
  check(
    "the owner still sees their own full profile under NO_ONE",
    ownProfile.status < 400 &&
      (ownProfile.body?.data ?? {}).friendsCount !== null,
    `status ${ownProfile.status} friendsCount=${JSON.stringify(ownProfile.body?.data?.friendsCount)}`
  );

  // --- 5. whoCanCallMe -----------------------------------------------------
  // Calls are initiated over the socket (`call:initiate`), not REST — there is
  // no HTTP entry point to probe here. The gate itself is covered by
  // tests/calls/call-service-gate.test.ts; this script only proves the setting
  // round-trips, below.
  await setPrivacy(subject, { whoCanCallMe: "NO_ONE" });

  // --- 6. settings round-trip (multi-device sync source of truth) ----------
  const readBack = await api("GET", "/api/v1/users/settings/me", {
    token: subject.token,
  });
  const privacy = readBack.body?.data?.privacy ?? {};
  check(
    "GET /settings/me reflects every PATCH (the payload multi-device sync ships)",
    privacy.whoCanCallMe === "NO_ONE" &&
      privacy.whoCanViewProfile === "NO_ONE" &&
      privacy.whoCanSeeOnlineStatus === "EVERYONE",
    JSON.stringify(privacy)
  );

  // --- 7. LIVE presence-subscription revocation ---------------------------
  // `presence:subscribe` authorizes once, at join time. Without server-side
  // re-authorization a watcher who subscribed while allowed keeps receiving
  // presence forever — including after the subject switches to NO_ONE. This is
  // the only check that exercises that revocation path.
  await setPrivacy(subject, { whoCanSeeOnlineStatus: "EVERYONE" });
  const revocation = await probeSubscriptionRevocation(subject, stranger);
  check(
    "a watcher subscribed under EVERYONE receives presence:status (positive control)",
    revocation.beforeChange === true,
    `received=${revocation.beforeChange}`
  );
  check(
    "switching to NO_ONE stops presence events for an ALREADY-subscribed watcher",
    revocation.afterChange === false,
    `received=${revocation.afterChange}`
  );

  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  console.log(`probe accounts: ${subject.account}, ${stranger.account}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
