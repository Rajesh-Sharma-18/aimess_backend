/**
 * Minimal, gateway-free check: does THIS tree's chat-service publish a
 * count-bearing `/notify` frame with `selfHiddenSessions` on it?
 *
 * A bare account-wide `unreadCount` with no `selfHiddenSessions` is unscopable
 * at the gateway, so the device that owns an unread Login Detected row is told a
 * number its own list contradicts. This subscribes to the raw Redis channel and
 * calls CreateNotification straight over gRPC, so nothing between the publisher
 * and the assertion can be blamed - no broker, no competing consumer, no gateway.
 *
 *   pnpm exec tsx scripts/probe-notify-frame-publisher.ts <userId>
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import Redis from "ioredis";

const REDIS_URL = process.env.PROBE_REDIS_URL ?? "redis://10.0.127.253:6379";
const CHAT_GRPC = process.env.PROBE_CHAT_GRPC ?? "127.0.0.1:4004";
const TOKEN =
  process.env.PROBE_GRPC_SERVICE_TOKEN ?? "dev-grpc-service-token-change-me";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function client(): {
  createNotification: (req: Record<string, unknown>) => Promise<{ id: string }>;
} {
  const protoPath = fileURLToPath(
    new URL(
      "../../../packages/grpc-contracts/proto/notification.proto",
      import.meta.url
    )
  );
  const def = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: Number,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as any;
  const Svc = Object.values(pkg)
    .map((ns: any) => ns?.NotificationService)
    .find(Boolean);
  const c = new Svc(CHAT_GRPC, grpc.credentials.createInsecure());
  const meta = new grpc.Metadata();
  meta.set("x-aimess-service-token", TOKEN);
  return {
    createNotification: (req) =>
      new Promise((resolve, reject) => {
        c.createNotification(req, meta, (err: unknown, res: any) =>
          err ? reject(err) : resolve(res)
        );
      }),
  };
}

async function main(): Promise<void> {
  const userId = process.argv[2];
  if (!userId) throw new Error("usage: probe-notify-frame-publisher.ts <userId>");

  const raw: { event: string; data: any }[] = [];
  const sub = new Redis(REDIS_URL);
  await sub.subscribe(`notify:${userId}`);
  sub.on("message", (_c, m) => {
    try {
      raw.push(JSON.parse(m));
    } catch {
      /* ignore */
    }
  });
  await sleep(500);

  const annId = randomUUID();
  const res = await client().createNotification({
    userId,
    actorId: "",
    type: "ANNOUNCEMENT",
    title: `Publisher probe ${annId.slice(0, 8)}`,
    body: `publisher probe ${annId}`,
    data: { announcementId: annId, type: "ANNOUNCEMENT" },
  });
  console.log(`created notification id=${res.id}`);

  for (let i = 0; i < 15; i++) {
    await sleep(700);
    if (raw.length > 0) break;
  }
  await sleep(1500);

  console.log(`\nraw frames on notify:${userId}`);
  for (const f of raw) {
    console.log(
      `  ${f.event} unreadCount=${String(f.data?.unreadCount)}` +
        ` count=${String(f.data?.count)}` +
        ` selfHiddenSessions=${JSON.stringify(f.data?.selfHiddenSessions)}`
    );
  }

  const countBearing = raw.filter(
    (f) => typeof f.data?.unreadCount === "number"
  );
  const missing = countBearing.filter(
    (f) => !Array.isArray(f.data?.selfHiddenSessions)
  );
  console.log(
    `\ncount-bearing frames=${countBearing.length}` +
      ` missing selfHiddenSessions=${missing.length}`
  );
  console.log(
    missing.length === 0
      ? "PASS  this chat-service tags every count-bearing frame"
      : "FAIL  this chat-service published an unscopable bare count"
  );

  sub.disconnect();
  process.exit(missing.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
