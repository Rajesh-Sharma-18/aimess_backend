import fs from "node:fs";
import { loginCached, api } from "./lib.mjs";
const A = await loginCached("A"); const B = await loginCached("B");
const out = { aUserId: A.userId, bUserId: B.userId };

const dm = await api(A.token, `/chat/private/rooms/${B.userId}`);
out.dmRoomId = dm.data.roomId;

// group
let groups = await api(A.token, "/chat/groups/my-groups?limit=50");
let list = groups?.data?.items ?? groups?.data ?? [];
let g = (Array.isArray(list) ? list : []).find((x) => (x.name ?? "").startsWith("burst-bench"));
if (!g) {
  const created = await api(A.token, "/chat/groups", { method: "POST", body: JSON.stringify({ name: `burst-bench ${Date.now()}`, description: "perf harness" }) });
  console.log("create group:", JSON.stringify(created).slice(0, 300));
  g = created?.data?.room ?? created?.data;
  const add = await api(A.token, "/chat/group-members/add", { method: "POST", body: JSON.stringify({ roomId: g.roomId ?? g.id, userIds: [B.userId] }) });
  console.log("add member:", JSON.stringify(add).slice(0, 300));
}
out.groupRoomId = g.roomId ?? g.id;

// community both are in
const ca = await api(A.token, "/communities/mine?limit=50");

const cb = await api(B.token, "/communities/mine?limit=50");
const ids = (r) => ((r?.data?.data ?? r?.data?.items ?? []).map?.((c) => c.id ?? c.communityId) ?? []);
const shared = ids(ca).filter((x) => ids(cb).includes(x));
out.communityId = shared[0] ?? null;
out.aCommunities = ids(ca).length; out.bCommunities = ids(cb).length;

fs.writeFileSync(`${process.env.BURST_BENCH_OUT ?? "."}/fixtures.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(0);
