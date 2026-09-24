/**
 * A SECOND session of one account, recording the list-bump frames it receives.
 *
 * Pair it with activity produced anywhere else — the browser session, a phone,
 * another probe — to check the multi-device contract: whichever device produced
 * the message, every other session of the same account gets the same
 * `community:updated` / `conv:updated`, and its REST list ends up agreeing.
 *
 * Usage (from apps/api-gateway):
 *   JWT_ACCESS_SECRET=<dev secret> USER=<uuid> [SECONDS=25] \
 *   pnpm exec tsx scripts/probe-list-sync-listen.ts
 */
import { randomUUID } from "node:crypto";

import { signAccessToken } from "@aimess/auth-jwt";
import { io, type Socket } from "socket.io-client";

const GW = process.env.GATEWAY_WS ?? "http://localhost:3000";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const USER = process.env.USER_ID ?? "";
const SECONDS = Number(process.env.SECONDS ?? "25");

if (!SECRET || !USER) {
  console.error("JWT_ACCESS_SECRET and USER_ID are required.");
  process.exit(2);
}

const tok = signAccessToken({
  userId: USER,
  sessionId: randomUUID(),
  secret: SECRET,
  expiresInSeconds: 3600,
});

async function connect(ns: "chat" | "community"): Promise<Socket> {
  const socket: Socket = io(`${GW}/${ns}`, {
    transports: ["websocket"],
    auth: { token: tok },
    forceNew: true,
  });
  socket.onAny((event: string, data: unknown) => {
    if (event !== "community:updated" && event !== "conv:updated") return;
    const d = (data ?? {}) as Record<string, unknown>;
    const last = (d.lastMessage ?? {}) as Record<string, unknown>;
    console.log(
      `${event} id=${String(d.communityId ?? d.roomId)} at=${String(
        d.lastMessageAt
      )} preview=${JSON.stringify(last.text ?? "")} unread=${String(d.unread)}`
    );
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (e: Error) => reject(e));
    setTimeout(() => reject(new Error(`${ns} connect timeout`)), 10_000);
  });
  return socket;
}

async function main(): Promise<void> {
  const community = await connect("community");
  const chat = await connect("chat");
  console.log(`second session listening for ${SECONDS}s…`);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  community.close();
  chat.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
