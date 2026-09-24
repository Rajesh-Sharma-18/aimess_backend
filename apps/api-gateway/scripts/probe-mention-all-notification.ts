/**
 * Live probe: does a GROUP @all notification say "mentioned @all", and does a
 * direct @handle mention still say "mentioned you"?
 *
 * Drives the real stack the way a client does — `message:send` on /chat with
 * server-shaped `mentions` entities — and records the `/notify` frames each
 * recipient receives, plus the persisted rows read back through the REST
 * notification list in en / vi / th.
 *
 * Covers: direct mention, bare @all, @all inside text, @all + @handle (one row,
 * USER wins), sender self-notification, deep-link navigation data, and
 * delete-for-everyone retraction.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> ROOM=grp_xxx SENDER=<uuid> \
 *   RECIPIENT_A=<uuid> RECIPIENT_B=<uuid> pnpm exec tsx \
 *   scripts/probe-mention-all-notification.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const API = process.env.GATEWAY_API ?? "http://localhost:3000/api/v1";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const ROOM = process.env.ROOM ?? "";
const SENDER = process.env.SENDER ?? "";
const A = process.env.RECIPIENT_A ?? "";
const B = process.env.RECIPIENT_B ?? "";

if (!SECRET || !ROOM || !SENDER || !A) {
  console.error(
    "ROOM, SENDER, RECIPIENT_A and JWT_ACCESS_SECRET are required."
  );
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const tokenFor = (userId: string): string =>
  signAccessToken({
    userId,
    sessionId: randomUUID(),
    secret: SECRET,
    expiresInSeconds: 3600,
  });

interface Frame {
  event: string;
  data: Record<string, unknown>;
  at: number;
}

class Client {
  readonly frames: Frame[] = [];
  readonly token: string;
  private constructor(
    readonly label: string,
    readonly userId: string,
    readonly chat: Socket,
    readonly notify: Socket,
    token: string
  ) {
    this.token = token;
  }

  static async connect(label: string, userId: string): Promise<Client> {
    const token = tokenFor(userId);
    const open = async (ns: string): Promise<Socket> => {
      const socket = io(`${GW}${ns}`, {
        transports: ["websocket"],
        auth: { token },
        forceNew: true,
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", (e: Error) => reject(e));
        setTimeout(
          () => reject(new Error(`${label}${ns} connect timeout`)),
          10000
        );
      });
      return socket;
    };
    const chat = await open("/chat");
    const notify = await open("/notify");
    const client = new Client(label, userId, chat, notify, token);
    for (const socket of [chat, notify]) {
      socket.onAny((event: string, ...args: unknown[]) => {
        client.frames.push({
          event,
          data: (args[0] ?? {}) as Record<string, unknown>,
          at: Date.now(),
        });
      });
    }
    return client;
  }

  emitAck(event: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      let done = false;
      this.chat.emit(event, payload, (res: unknown) => {
        done = true;
        resolve(res);
      });
      setTimeout(() => {
        if (!done) resolve({ timeout: true });
      }, 10000);
    });
  }

  /** `/notify` new-notification frames seen since `since`. */
  notifications(since: number): Frame[] {
    return this.frames.filter(
      (f) => f.at >= since && f.event === "notification:new"
    );
  }

  deletions(since: number): Frame[] {
    return this.frames.filter(
      (f) => f.at >= since && f.event === "notification:deleted"
    );
  }

  /** Persisted rows, rendered by chat-service in `lang`. */
  async inbox(lang: string): Promise<Record<string, unknown>[]> {
    const res = await fetch(
      `${API}/chat/notifications?type=MENTIONS&limit=30`,
      {
        headers: { Authorization: `Bearer ${this.token}`, "x-lang": lang },
      }
    );
    const json = (await res.json()) as {
      data?: { data?: Record<string, unknown>[] } | Record<string, unknown>[];
    };
    const data = json.data;
    return (Array.isArray(data) ? data : (data?.data ?? [])) as Record<
      string,
      unknown
    >[];
  }

  close(): void {
    this.chat.close();
    this.notify.close();
  }
}

const bodyOf = (f: Frame): string =>
  String(
    f.data.body ?? (f.data.payload as { body?: string } | undefined)?.body ?? ""
  );
const dataOf = (f: Frame): Record<string, unknown> =>
  (f.data.data ?? {}) as Record<string, unknown>;

/** Offsets of `token` ("@all", "@kristi") in `text`, as the client computes them. */
function spanOf(
  text: string,
  token: string
): { offset: number; length: number } {
  const offset = text.indexOf(token);
  if (offset < 0) throw new Error(`"${token}" not in "${text}"`);
  return { offset, length: token.length };
}

async function send(
  sender: Client,
  text: string,
  mentions: Record<string, unknown>[]
): Promise<string> {
  const ack = (await sender.emitAck("message:send", {
    conversationId: ROOM,
    conversationType: "group",
    contentType: "TEXT",
    contentText: text,
    clientMessageId: randomUUID(),
    mentions,
  })) as {
    success?: boolean;
    data?: { messageId?: string; id?: string };
    message?: string;
  };
  const id = ack?.data?.messageId ?? ack?.data?.id ?? "";
  if (!id) console.log(`      send ack: ${JSON.stringify(ack)}`);
  return id;
}

async function main(): Promise<void> {
  const sender = await Client.connect("sender", SENDER);
  const a = await Client.connect("A", A);
  const b = B ? await Client.connect("B", B) : null;

  // The recipient's CURRENT handle — the mention text must match it or the
  // server drops the entity.
  const membersRes = await fetch(`${API}/chat/group-members/${ROOM}`, {
    headers: { Authorization: `Bearer ${sender.token}` },
  });
  const membersJson = (await membersRes.json()) as {
    data?:
      | { data?: Record<string, unknown>[]; items?: Record<string, unknown>[] }
      | Record<string, unknown>[];
  };
  const raw = membersJson.data;
  const members = (
    Array.isArray(raw) ? raw : (raw?.data ?? raw?.items ?? [])
  ) as Record<string, unknown>[];
  const handleOf = (userId: string): string => {
    const m = members.find(
      (x) =>
        x.userId === userId ||
        x.id === userId ||
        (x.user as { id?: string } | undefined)?.id === userId
    );
    return String(
      m?.memberId ??
        m?.username ??
        (m?.user as { memberId?: string } | undefined)?.memberId ??
        ""
    );
  };
  const handleA = handleOf(A);
  check("recipient A handle resolved", Boolean(handleA), handleA || "(none)");
  if (!handleA) {
    console.log(JSON.stringify(members.slice(0, 3), null, 2));
    process.exit(1);
  }

  // ── 1. Direct @handle mention ────────────────────────────────────────────
  console.log("\n--- 1. direct mention ---");
  let t0 = Date.now();
  const text1 = `Hello @${handleA}`;
  const id1 = await send(sender, text1, [
    { type: "USER", userId: A, ...spanOf(text1, `@${handleA}`) },
  ]);
  await sleep(4000);

  const n1 = a.notifications(t0).filter((f) => dataOf(f).messageId === id1);
  check("A got exactly one row", n1.length === 1, `got ${n1.length}`);
  if (n1[0]) {
    check(
      "A row says 'mentioned you'",
      bodyOf(n1[0]).includes("mentioned you"),
      bodyOf(n1[0])
    );
    check("A row mentionType=USER", dataOf(n1[0]).mentionType === "USER");
    const nav = JSON.parse(String(dataOf(n1[0]).navigation ?? "{}")) as Record<
      string,
      unknown
    >;
    check(
      "A row deep-links to the message",
      nav.roomId === ROOM && nav.messageId === id1,
      JSON.stringify(nav)
    );
  }
  if (b) {
    check(
      "B got no direct-mention row",
      b.notifications(t0).filter((f) => dataOf(f).messageId === id1).length ===
        0
    );
  }
  check(
    "sender got no self-notification",
    sender.notifications(t0).filter((f) => dataOf(f).messageId === id1)
      .length === 0
  );

  // ── 2. Bare @all ─────────────────────────────────────────────────────────
  console.log("\n--- 2. @all ---");
  t0 = Date.now();
  const text2 = "@all";
  const id2 = await send(sender, text2, [
    { type: "ALL", ...spanOf(text2, "@all") },
  ]);
  await sleep(4000);

  for (const [label, cl] of [
    ["A", a],
    ...(b ? ([["B", b]] as const) : []),
  ] as const) {
    const rows = cl
      .notifications(t0)
      .filter((f) => dataOf(f).messageId === id2);
    check(
      `${label} got exactly one @all row`,
      rows.length === 1,
      `got ${rows.length}`
    );
    if (!rows[0]) continue;
    check(
      `${label} @all row does NOT say 'mentioned you'`,
      !bodyOf(rows[0]).includes("mentioned you"),
      bodyOf(rows[0])
    );
    check(
      `${label} @all row says 'mentioned @all'`,
      bodyOf(rows[0]).includes("mentioned @all"),
      bodyOf(rows[0])
    );
    check(
      `${label} @all row mentionType=ALL`,
      dataOf(rows[0]).mentionType === "ALL"
    );
  }
  check(
    "sender got no @all self-notification",
    sender.notifications(t0).filter((f) => dataOf(f).messageId === id2)
      .length === 0
  );

  // ── 3. @all inside ordinary text ─────────────────────────────────────────
  console.log("\n--- 3. @all in a sentence ---");
  t0 = Date.now();
  const text3 = "Please check this @all, thanks";
  const id3 = await send(sender, text3, [
    { type: "ALL", ...spanOf(text3, "@all") },
  ]);
  await sleep(4000);
  const n3 = a.notifications(t0).filter((f) => dataOf(f).messageId === id3);
  check(
    "mid-sentence @all still notifies A",
    n3.length === 1,
    `got ${n3.length}`
  );
  if (n3[0]) {
    check(
      "mid-sentence @all says 'mentioned @all'",
      bodyOf(n3[0]).includes("mentioned @all"),
      bodyOf(n3[0])
    );
  }

  // ── 4. @all + @handle for the same recipient ─────────────────────────────
  console.log("\n--- 4. @all + direct ---");
  t0 = Date.now();
  const text4 = `@all @${handleA} please check`;
  const id4 = await send(sender, text4, [
    { type: "ALL", ...spanOf(text4, "@all") },
    { type: "USER", userId: A, ...spanOf(text4, `@${handleA}`) },
  ]);
  await sleep(4000);
  const n4 = a.notifications(t0).filter((f) => dataOf(f).messageId === id4);
  check("A got ONE row, not two", n4.length === 1, `got ${n4.length}`);
  if (n4[0]) {
    check(
      "A's row is the direct one ('mentioned you')",
      dataOf(n4[0]).mentionType === "USER" &&
        bodyOf(n4[0]).includes("mentioned you"),
      `${String(dataOf(n4[0]).mentionType)} / ${bodyOf(n4[0])}`
    );
  }
  if (b) {
    const rowsB = b
      .notifications(t0)
      .filter((f) => dataOf(f).messageId === id4);
    check("B got one @all row", rowsB.length === 1, `got ${rowsB.length}`);
    if (rowsB[0]) {
      check(
        "B's row says 'mentioned @all'",
        dataOf(rowsB[0]).mentionType === "ALL" &&
          bodyOf(rowsB[0]).includes("mentioned @all"),
        bodyOf(rowsB[0])
      );
    }
  }

  // ── 5. Persisted rows, read back in each language ────────────────────────
  console.log("\n--- 5. persisted rows in en / vi / th ---");
  const expect: Record<string, { user: string; all: string }> = {
    en: { user: "mentioned you", all: "mentioned @all" },
    vi: { user: "đã nhắc đến bạn", all: "đã nhắc đến @all" },
    th: { user: "กล่าวถึงคุณ", all: "กล่าวถึง @all" },
  };
  for (const lang of ["en", "vi", "th"]) {
    const items = await a.inbox(lang);
    const row = (id: string): Record<string, unknown> | undefined =>
      items.find(
        (i) =>
          ((i.data ?? {}) as { messageId?: string }).messageId === id ||
          ((i.payload as { data?: { messageId?: string } } | undefined)?.data
            ?.messageId ?? "") === id
      );
    const direct = row(id1);
    const all = row(id2);
    const bodyOfRow = (r?: Record<string, unknown>): string =>
      String(
        r?.body ?? (r?.payload as { body?: string } | undefined)?.body ?? ""
      );
    check(
      `${lang}: direct row reads "mentioned you"`,
      bodyOfRow(direct).includes(expect[lang]!.user),
      bodyOfRow(direct)
    );
    check(
      `${lang}: @all row reads "mentioned @all"`,
      bodyOfRow(all).includes(expect[lang]!.all),
      bodyOfRow(all)
    );
    check(
      `${lang}: @all row never says "you"`,
      !bodyOfRow(all).includes(expect[lang]!.user),
      bodyOfRow(all)
    );
    check(
      `${lang}: no raw translation key leaked`,
      !/NOTIF_[A-Z_]+/.test(bodyOfRow(direct) + bodyOfRow(all)),
      bodyOfRow(all)
    );
  }

  // ── 6. Delete for everyone retracts the @all row ─────────────────────────
  console.log("\n--- 6. delete for everyone ---");
  t0 = Date.now();
  const delRes = await fetch(
    `${API}/chat/groups/messages/${id2}?type=forEveryone`,
    { method: "DELETE", headers: { Authorization: `Bearer ${sender.token}` } }
  );
  check("delete-for-everyone accepted", delRes.ok, `HTTP ${delRes.status}`);
  await sleep(4000);
  check(
    "A's @all row was retracted",
    a.deletions(t0).length > 0,
    JSON.stringify(a.deletions(t0).map((f) => f.data))
  );
  const afterDelete = await a.inbox("en");
  check(
    "@all row is gone from the persisted list",
    !afterDelete.some(
      (i) => ((i.data ?? {}) as { messageId?: string }).messageId === id2
    )
  );

  sender.close();
  a.close();
  b?.close();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
