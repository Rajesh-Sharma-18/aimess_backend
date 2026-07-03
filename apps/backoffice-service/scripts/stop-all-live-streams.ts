import { streamClient } from "../src/grpc/stream.client.js";

async function main() {
  let page = 1;
  const limit = 100;
  let stopped = 0;

  for (;;) {
    const { streams, total } = await streamClient.adminListStreams({
      status: "LIVE",
      page,
      limit,
    });
    if (streams.length === 0) break;

    for (const s of streams) {
      const r = await streamClient.adminForceEnd(s.id, "bulk_admin_stop");
      if (r.success) stopped++;
      console.log(s.id, r.status);
    }

    if (page * limit >= total) break;
    page++;
  }

  console.log(`stopped ${stopped} stream(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
