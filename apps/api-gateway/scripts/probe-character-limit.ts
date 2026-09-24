/**
 * Live probe: can a request that never went near the website persist a value
 * longer than 30 characters?
 *
 * The forms clamp, so the only honest way to answer is to skip them — these are
 * raw HTTP calls against the running gateway, the same thing an older mobile
 * build, another platform, curl, or a tampered browser would send. Every field
 * is driven at 30 / 31 / 50 plus a Unicode row, on CREATE and on EDIT, and each
 * 400 is checked for the project's normal envelope (VALIDATION_FAILED with
 * per-field `details`) rather than some bespoke shape.
 *
 * Also asserts what must NOT have changed: a handle that predates the rule is
 * still resolvable, and an existing over-long profile field does not block a
 * request that leaves it alone.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> pnpm exec tsx scripts/probe-character-limit.ts
 *
 * Optional env: USER_A (a real dev user UUID), GATEWAY_API.
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";

const API = process.env.GATEWAY_API ?? "http://localhost:3000/api/v1";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const USER_A = process.env.USER_A ?? "7b0db132-ffff-4d99-ab3c-421f83fba2ef";
// Groups are probed as a SECOND account: group creation is rate limited to 10 a
// day per user and the REJECTED attempts are counted too, so sharing one
// account exhausts the budget mid-run.
const USER_B = process.env.USER_B ?? "1b98aed5-cc15-41d6-95bb-bef47a44f063";

if (!SECRET) {
  console.error("JWT_ACCESS_SECRET is required.");
  process.exit(2);
}

const MAX = 30;
const tokenFor = (userId: string): string =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 3600,
  });
const token = tokenFor(USER_A);
const groupToken = tokenFor(USER_B);

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

interface Reply {
  status: number;
  body: {
    success?: boolean;
    message?: string;
    data?: unknown;
    error?: { code?: string; details?: Record<string, string[]> };
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  lang?: string,
  as: string = token
): Promise<Reply> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${as}`,
      "content-type": "application/json",
      ...(lang ? { "x-lang": lang } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await res.json().catch(() => ({}))) as Reply["body"];
  return { status: res.status, body: parsed };
}

/** A 400 in the project's normal validation shape, naming the offending field. */
function rejectedForLength(reply: Reply, field: string): boolean {
  return (
    reply.status === 400 &&
    reply.body.error?.code === "VALIDATION_FAILED" &&
    Boolean(reply.body.error.details?.[field]?.length)
  );
}

const chars = (n: number, unit = "a"): string => unit.repeat(n);
const dataOf = <T,>(reply: Reply): T => reply.body.data as T;

async function probeProfile(): Promise<void> {
  const before = await call("GET", "/users/profiles/me");
  check("baseline profile readable", before.status === 200, `status ${before.status}`);
  const profile = dataOf<Record<string, string> | undefined>(before) ?? {};

  for (const field of ["firstName", "lastName"] as const) {
    check(
      `${field}: ${MAX} accepted`,
      (await call("PATCH", "/users/profiles/me", { [field]: chars(MAX) })).status === 200
    );
    for (const n of [MAX + 1, 50]) {
      const reply = await call("PATCH", "/users/profiles/me", { [field]: chars(n) });
      check(`${field}: ${n} rejected`, rejectedForLength(reply, field), `status ${reply.status}`);
    }
    // 30 CHARACTERS of Thai is ~90 code units: the limit counts characters.
    check(
      `${field}: ${MAX} Thai characters accepted`,
      (await call("PATCH", "/users/profiles/me", { [field]: chars(MAX, "กิ") })).status === 200
    );
    check(
      `${field}: ${MAX + 1} emoji rejected`,
      rejectedForLength(
        await call("PATCH", "/users/profiles/me", { [field]: chars(MAX + 1, "😀") }),
        field
      )
    );
    if (profile[field]) {
      await call("PATCH", "/users/profiles/me", { [field]: profile[field] });
    }
  }

  // Acceptance is proved through the availability endpoint, which runs the SAME
  // `usernameSchema` as the PATCH. Deliberately NOT by claiming a handle: a
  // username change is throttled to one per 30 days, so a probe that wrote one
  // would leave a real dev account stuck with a probe handle for a month.
  const probeName = `p${Date.now().toString(36)}`.padEnd(MAX, "x").slice(0, MAX);
  const available = await call("GET", `/users/usernames/validate?username=${probeName}`);
  check(
    `username: ${MAX} passes validation`,
    available.status === 200,
    `status ${available.status} ${available.body.message ?? ""}`
  );
  for (const n of [MAX + 1, 50]) {
    check(
      `username: ${n} rejected on the availability check`,
      rejectedForLength(
        await call("GET", `/users/usernames/validate?username=${chars(n)}`),
        "username"
      )
    );
    // …and on the write path itself, which is the one that matters.
    const reply = await call("PATCH", "/users/profiles/me", { username: chars(n) });
    check(`username: ${n} rejected on PATCH`, rejectedForLength(reply, "username"), `status ${reply.status}`);
  }

  // A value the request does not TOUCH is not re-validated, so a profile that
  // predates the rule can still have its other fields edited. Asserted by
  // re-sending a field's CURRENT value — a no-op write, so a probe run leaves
  // the account exactly as it found it.
  check(
    "a field left out of the patch does not block the request",
    (await call("PATCH", "/users/profiles/me", { firstName: profile.firstName ?? "Probe" }))
      .status === 200
  );
}

async function probeAccount(): Promise<void> {
  const password = "Str0ng!Passw0rd";
  for (const n of [MAX + 1, 50]) {
    const reply = await call("POST", "/auth/register", { account: chars(n), password });
    check(
      `account: ${n} rejected before any account exists`,
      rejectedForLength(reply, "account"),
      `status ${reply.status}`
    );
  }
}

async function probeCommunity(): Promise<void> {
  const categories = await call("GET", "/communities/categories");
  const categoryId = dataOf<{ categories?: { id: string }[] } | undefined>(categories)
    ?.categories?.[0]?.id;
  check("a community category is available", Boolean(categoryId), `status ${categories.status}`);
  if (!categoryId) return;

  const stamp = Date.now().toString(36);
  const good = {
    name: `Probe ${stamp}`,
    handle: `probe_${stamp}`,
    type: "PUBLIC",
    categoryId,
  };

  for (const [field, value] of [
    ["name", chars(MAX + 1)],
    ["name", chars(50)],
    ["handle", chars(MAX + 1)],
    ["handle", chars(50)],
  ] as const) {
    const reply = await call("POST", "/communities", { ...good, [field]: value });
    check(
      `community ${field}: ${value.length} rejected on create`,
      rejectedForLength(reply, field),
      `status ${reply.status}`
    );
  }

  const created = await call("POST", "/communities", good);
  check(
    "community with a valid name created",
    created.status === 200 || created.status === 201,
    `status ${created.status}`
  );
  const createdBody = dataOf<{ id?: string; community?: { id?: string } } | undefined>(created);
  const communityId = createdBody?.id ?? createdBody?.community?.id;

  if (communityId) {
    check(
      `community name: ${MAX} accepted on edit`,
      (await call("PATCH", `/communities/${communityId}`, { name: chars(MAX) })).status === 200
    );
    for (const field of ["name", "handle"] as const) {
      const reply = await call("PATCH", `/communities/${communityId}`, {
        [field]: chars(MAX + 1),
      });
      check(
        `community ${field}: ${MAX + 1} rejected on EDIT too`,
        rejectedForLength(reply, field),
        `status ${reply.status}`
      );
    }
    await call("DELETE", `/communities/${communityId}`);
  }

  // A handle from before the rule must still RESOLVE — the cap is on claiming
  // one, not on looking one up. Anything but a 400 means the shape was accepted.
  const lookup = await call("GET", `/communities/by-handle/${chars(32)}`);
  check(
    "a 32-character handle is still a valid lookup",
    lookup.status !== 400,
    `status ${lookup.status}`
  );
}

/**
 * Groups are probed as a SECOND user: group creation is rate limited to 10 a
 * day per account, and the rejected attempts count against it too, so reusing
 * the profile probe's account exhausts the budget mid-run.
 */
async function probeGroup(): Promise<void> {
  for (const n of [MAX + 1, 50, 100]) {
    const reply = await call("POST", "/chat/groups", { name: chars(n) }, undefined, groupToken);
    check(
      `group name: ${n} rejected on create`,
      rejectedForLength(reply, "name"),
      `status ${reply.status}`
    );
  }

  const created = await call("POST", "/chat/groups", { name: chars(MAX) }, undefined, groupToken);
  check(
    `group name: ${MAX} accepted`,
    created.status === 200 || created.status === 201,
    `status ${created.status}`
  );
  // The room id the PATCH route takes is the opaque `grp_...`, not the Mongo _id.
  const groupId = dataOf<{ room?: { roomId?: string } } | undefined>(created)?.room?.roomId;
  check("created group returned a room id", Boolean(groupId));
  if (!groupId) return;

  check(
    `group name: ${MAX} emoji accepted on edit`,
    (
      await call(
        "PATCH",
        `/chat/groups/rooms/${groupId}`,
        { name: chars(MAX, "😀") },
        undefined,
        groupToken
      )
    ).status === 200
  );
  const reply = await call(
    "PATCH",
    `/chat/groups/rooms/${groupId}`,
    { name: chars(MAX + 1) },
    undefined,
    groupToken
  );
  check(
    `group name: ${MAX + 1} rejected on EDIT too`,
    rejectedForLength(reply, "name"),
    `status ${reply.status}`
  );

  await call("POST", `/chat/groups/rooms/${groupId}/disband`, undefined, undefined, groupToken);
}

async function probeLocales(): Promise<void> {
  for (const lang of ["en", "vi", "th"]) {
    const reply = await call("PATCH", "/users/profiles/me", { firstName: chars(50) }, lang);
    const sentence = reply.body.error?.details?.firstName?.[0] ?? "";
    check(
      `${lang}: the refusal is a sentence, not a raw message key`,
      sentence.length > 0 && !sentence.startsWith("VALIDATION_"),
      sentence
    );
  }
}

async function main(): Promise<void> {
  await probeProfile();
  await probeAccount();
  await probeCommunity();
  await probeGroup();
  await probeLocales();

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
