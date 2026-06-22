# `community:updated` — Community List Bump-to-Top (FE Flow)

> **Audience:** frontend. **Canonical contract:** [`docs/SOCKET_EVENTS.md`](SOCKET_EVENTS.md) §5 (`/community`), §7.6 (list bump), §10 (index) and [`apps/api-gateway/asyncapi/asyncapi.yaml`](../apps/api-gateway/asyncapi/asyncapi.yaml) (`community.onCommunityUpdated`).

`community:updated` is the WhatsApp/Telegram-style **"move this community to the top of the list"** hint. It fires to **every active member** of a community whenever a new message is posted there, so a client sitting on the **community list / inbox screen** can reorder the list and update the preview + unread badge **without refetching**.

> ⚠️ **The one rule that trips everyone up:** `community:updated` is delivered on the **`/community`** namespace — **NOT `/chat`**. (It used to be on `/chat`; it was moved.) Its sibling `conv:updated` — the bump for **private/group** chats — stays on `/chat`. They are separate concerns on separate namespaces.

| Event               | List it bumps         | Namespace        | Personal room |
| ------------------- | --------------------- | ---------------- | ------------- |
| `conv:updated`      | private + group inbox | `/chat`          | `user:<id>`   |
| `community:updated` | community list        | **`/community`** | `user:<id>`   |

---

## End-to-end flow

```
A new message is posted in community C (via socket community:message:send OR REST)
        │
        ▼
chat-service (publish-conv-updated.ts → publishCommunityUpdated)
        │  for EACH active member m of C:
        │  redis.publish("user:<m>", { event: "community:updated", data })
        ▼
api-gateway  /community namespace  (community.ns.ts)
        │  psubscribe("user:*")  →  event starts with "community:"  →  forward
        │  community.to("user:<m>").emit("community:updated", data)
        ▼
Frontend  (socket connected to /community, auto-joined user:<m>)
        communitySocket.on("community:updated", …)
        → splice community C to top of the list, update preview + unread
```

Backend ground truth:

- Publisher: [`apps/chat-service/src/events/publish-conv-updated.ts`](../apps/chat-service/src/events/publish-conv-updated.ts) → `publishCommunityUpdated` / `publishCommunityUpdatedSafe` (publishes to `user:<memberId>`).
- Gateway bridge: [`apps/api-gateway/src/sockets/namespaces/community.ns.ts`](../apps/api-gateway/src/sockets/namespaces/community.ns.ts) — the `user:*` `pmessage` handler forwards events whose name starts with `community:` to the `user:<id>` room; every `/community` socket runs `socket.join("user:<userId>")` on connect.
- The `/chat` namespace ([`chat.ns.ts`](../apps/api-gateway/src/sockets/namespaces/chat.ns.ts)) explicitly **filters out** `community:*` events, so it will **never** deliver `community:updated`.

---

## Payload

```ts
interface CommunityUpdated {
  communityId: string;
  roomId: string; // GeneralRoom id (=== communityId for the general room)
  lastMessageId: string; // use as the idempotency key
  lastMessage: {
    contentType: string; // UPPER-CASE: TEXT | IMAGE | VIDEO | GIF | AUDIO | VOICE | STICKER | LOCATION | CONTACT | SYSTEM
    text: string; // server-rendered preview, ready to display (see below)
  };
  lastMessageAt: number; // epoch MILLISECONDS (a number — NOT an ISO string)
  senderId: string;
  senderName: string;
  unread: boolean; // true for everyone except the sender (false on your own send)
}
```

`lastMessage.text` is already a display-ready preview (same vocabulary as the REST inbox and push):
`TEXT`→first ~200 chars · `IMAGE`→`📷 Photo` · `VIDEO`→`🎥 Video` · `GIF`→`🎞 GIF` · `AUDIO`→`🎵 Audio` · `VOICE`→`🎤 Voice message` · `STICKER`→`🌟 Sticker` · `LOCATION`→`📍 {placeName}` · `CONTACT`→`👤 {name}` · `SYSTEM`→the system sentence. You may re-localize, but you can render it as-is.

---

## Frontend usage (React/TS)

```ts
import { io, Socket } from "socket.io-client";

// 1. Connect to the /community namespace. user:<id> is auto-joined at connect —
//    you do NOT need community:join to receive community:updated.
const communitySocket: Socket = io(`${API_BASE}/community`, {
  auth: { token: accessToken },
  transports: ["websocket"],
});

// 2. Listen for the bump and reorder the list.
communitySocket.on("community:updated", (u: CommunityUpdated) => {
  setCommunities((prev) => {
    const idx = prev.findIndex((c) => c.id === u.communityId);
    if (idx === -1) return prev; // not in the loaded list — ignore (or refetch)

    const next = [...prev];
    const [c] = next.splice(idx, 1);

    // Idempotency guard: ignore a stale/duplicate bump.
    if (c.lastMessageId === u.lastMessageId) {
      next.unshift(c);
      return next;
    }

    next.unshift({
      ...c,
      lastMessageId: u.lastMessageId,
      lastMessagePreview: u.lastMessage.text,
      lastMessageAt: u.lastMessageAt,
      // increment unread only when it's not your own message
      unreadCount: u.unread ? (c.unreadCount ?? 0) + 1 : 0,
    });
    return next;
  });
});

// 3. Cleanup
// communitySocket.off("community:updated");
```

If you render a **unified inbox** (private + group + communities together), connect to **both** namespaces and listen on each:

- `/chat` → `conv:updated` (private/group rows)
- `/community` → `community:updated` (community rows)

---

## Rules & gotchas

- **Namespace:** `/community` only. Listening on `/chat` for `community:updated` = you get nothing.
- **You receive it on the list screen.** It targets your personal `user:<id>` room (auto-joined), not the `community:<id>` broadcast room — so you get it even when you're not currently viewing that community. (`community:join` is only needed for in-room events like `community:message:new`.)
- **Idempotent.** Keyed by `lastMessageId`. Receiving the same bump twice must be a no-op — guard on it.
- **`unread` is a boolean hint**, not a count. It's `false` on the sender's own copy. Derive your numeric badge locally (or from `GET /rooms` `hasUnread` / unread counts on reload).
- **`lastMessageAt` is epoch ms (number).** Don't `new Date(isoString)` it — `new Date(number)`.
- **It's independent from `community:message:new`.** A member viewing the community receives **both**: `community:message:new` (append the bubble, on the `community:<id>` room) and `community:updated` (reorder the list). Handle them separately.
- **New community → `community:created`** also arrives on `/community` (to the creator's `user:<id>`), to insert a brand-new community into the list. Same namespace, same pattern.

---

## Related

- `community:message:new` / `:edited` / `:deleted` / `:reaction` / `:pinned` — in-room events on the `community:<id>` room (see [`docs/COMMUNITY_MESSAGING_REALTIME_FLOW.md`](COMMUNITY_MESSAGING_REALTIME_FLOW.md)).
- `conv:updated` — the `/chat` equivalent for private/group inbox bumps.
