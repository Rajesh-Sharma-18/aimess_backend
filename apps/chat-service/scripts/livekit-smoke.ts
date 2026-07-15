/**
 * Phase 0/1 smoke check: mint a LiveKit token and hit the running
 * livekit-server's /rtc/validate to prove the token/key match.
 *
 * Standalone — does NOT load the chat-service env schema (which needs a real
 * .env). Reads LIVEKIT_* from process.env with dev defaults.
 *
 * Usage:
 *   pnpm --filter @aimess/chat-service exec tsx scripts/livekit-smoke.ts
 *
 * ponytail: throwaway diagnostic — delete after Phase 1 lands if we don't
 * turn it into a real integration test.
 */
import { AccessToken } from "livekit-server-sdk";

const URL_ = process.env.LIVEKIT_URL ?? "ws://localhost:7880";
const KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const SECRET =
  process.env.LIVEKIT_API_SECRET ?? "devsecretchangeme_at_least_32_chars_long";

async function mint(room: string, identity: string): Promise<string> {
  const at = new AccessToken(KEY, SECRET, { identity, ttl: 3600 });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}

async function main() {
  const room = "smoke-" + Math.random().toString(36).slice(2, 8);
  const aliceToken = await mint(room, "alice");
  const bobToken = await mint(room, "bob");
  const httpUrl = URL_.replace(/^ws/, "http");
  const validate = async (label: string, tok: string) => {
    const res = await fetch(
      `${httpUrl}/rtc/validate?access_token=${encodeURIComponent(tok)}`
    );
    console.log(`validate ${label} → HTTP`, res.status, await res.text());
  };
  await validate("alice", aliceToken);
  await validate("bob  ", bobToken);

  console.log("\n=== paste into meet.livekit.io (custom tab) ===");
  console.log("URL  :", URL_);
  console.log("ROOM :", room);
  console.log("\n--- ALICE (tab 1) ---\n" + aliceToken);
  console.log("\n--- BOB (tab 2) ---\n" + bobToken);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
