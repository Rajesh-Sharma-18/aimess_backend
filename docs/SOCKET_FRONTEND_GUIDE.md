# AIMess — Next.js / React Socket Implementation Guide

A practical, copy-paste-oriented guide for frontend developers wiring the AIMess
real-time chat into a **Next.js (App Router) + Redux Toolkit + TanStack Query**
client. It distills the canonical contract in
[`SOCKET_EVENTS.md`](SOCKET_EVENTS.md) into the code you actually write.

> **Source of truth:** [`SOCKET_EVENTS.md`](SOCKET_EVENTS.md) is authoritative for
> every event name, payload, and edge case. This guide shows _how_ to consume it.
> If the two disagree, the contract wins.

**Division of labor in this stack**

- **Socket.IO** — all real-time traffic (send/receive messages, receipts, typing,
  presence, reactions, calls). One client, three namespaces.
- **TanStack Query** — REST reads/writes: inbox list, message history first page,
  friendships, community moderation, conversation create/delete, media presign.
- **Redux Toolkit** — in-memory live state the socket mutates: open conversation
  messages, typing maps, presence map, unread counts, connection status.

REST is the authoritative mutation path for edit/delete; the socket events are the
**broadcast**. Never double-apply a socket echo of your own REST mutation.

---

## 1. Install & environment

```bash
pnpm add socket.io-client @reduxjs/toolkit react-redux @tanstack/react-query
```

```bash
# .env.local
NEXT_PUBLIC_SOCKET_URL=http://localhost:8000   # gateway origin (WSS in prod)
NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1
```

Key facts from the contract you must respect:

| Property       | Value                                                             |
| -------------- | ----------------------------------------------------------------- |
| Transport path | `/socket.io/`                                                     |
| Namespaces     | `/chat`, `/community`, `/notify` (one multiplexed connection)     |
| Auth           | JWT **access token** on the handshake — no anonymous sockets      |
| State recovery | `connectionStateRecovery` — up to **2 min** reconnect window      |
| Max payload    | 1 MB — **file bytes never cross the socket** (upload first)       |
| Ordering key   | per-room `sequenceNumber` — sort & dedupe by it, not arrival time |

---

## 2. The socket singleton

Socket.IO multiplexes all three namespaces over **one** underlying connection.
Create them once, outside React, and reuse. Never instantiate inside a component
body.

```ts
// lib/socket/index.ts
import { io, type Socket } from "socket.io-client";

const BASE_URL = process.env.NEXT_PUBLIC_SOCKET_URL!;

type Sockets = { chat: Socket; community: Socket; notify: Socket };
let sockets: Sockets | null = null;

/** getToken: a function returning the *current* access token (so reconnects use a fresh one). */
export function initSockets(getToken: () => string | null): Sockets {
  if (sockets) return sockets;

  const common = {
    path: "/socket.io/",
    transports: ["websocket", "polling"], // WS-first, polling fallback
    autoConnect: false,
    auth: (cb: (d: { token: string | null }) => void) =>
      cb({ token: getToken() }),
    // Socket.IO defaults: exponential backoff 1s → 5s, randomization 0.5
  };

  const chat = io(`${BASE_URL}/chat`, {
    ...common,
    query: { platform: "web", clientType: "web" }, // recorded in presence
  });
  const community = io(`${BASE_URL}/community`, common);
  const notify = io(`${BASE_URL}/notify`, common);

  sockets = { chat, community, notify };
  return sockets;
}

export function getSockets(): Sockets {
  if (!sockets)
    throw new Error("Sockets not initialized — call initSockets first");
  return sockets;
}

export function connectAll() {
  const s = getSockets();
  s.chat.connect();
  s.community.connect();
  s.notify.connect();
}

export function disconnectAll() {
  if (!sockets) return;
  Object.values(sockets).forEach((sock) => sock.disconnect());
}
```

> **Token on reconnect.** Passing `auth` as a _function_ means Socket.IO calls it
> on every (re)connect, so a refreshed token is always used. The gateway
> re-verifies auth on every reconnect (§8.1 / §8.9). On `connect_error` with
> `"Authentication failed"`, refresh the token then `socket.connect()` again.

### Typed ack helper

Every acked event answers with the **same** envelope. Wrap `emit` in a promise so
you can `await` it.

```ts
// lib/socket/emit.ts
import type { Socket } from "socket.io-client";

export type Ack<T = unknown> =
  | { success: true; message: string; data?: T }
  | {
      success: false;
      error: SocketErrorCode;
      retryable: boolean;
      message: string;
    };

export type SocketErrorCode =
  | "INVALID_PAYLOAD" // false — fix payload, do not retry
  | "SERVICE_ERROR" // true  — retry with backoff
  | "RATE_LIMITED" // true  — back off until retryAfter, then one retry
  | "FORBIDDEN" // false — surface, do not retry
  | "NOT_FOUND" // false — surface, do not retry
  | "CONFLICT"; // false — reconcile, do not blind-retry

export function emitAck<T = unknown>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = 10_000
): Promise<Ack<T>> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done)
        resolve({
          success: false,
          error: "SERVICE_ERROR",
          retryable: true,
          message: "Request timed out",
        });
    }, timeoutMs);
    socket.emit(event, payload, (res: Ack<T>) => {
      done = true;
      clearTimeout(t);
      resolve(res);
    });
  });
}
```

> **Branch on `success` / `error` / `retryable` — never on the `message` string**
> (it is a localized, display-ready sentence). All six error codes are part of the
> contract; handle them all today even though the gateway currently only emits
> `INVALID_PAYLOAD` and `SERVICE_ERROR` directly.
>
> **Numeric ack fields** (`sentAt`, `editedAt`, `pinnedAt`, `sequenceNumber`) are
> plain epoch-ms / integer **numbers** on both the ack path and server→client
> broadcasts — the gateway coerces the gRPC `int64` wire-strings before relaying.

---

## 3. Redux: live chat state

TanStack Query owns REST data; Redux owns the volatile socket-driven state.

```ts
// store/chatSlice.ts
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type ChatMessage = {
  id: string;
  clientMessageId?: string;
  roomId: string;
  conversationType: "private" | "group";
  senderId: string;
  senderName?: string;
  senderAvatar?: string;
  contentType: string; // UPPER-CASE: TEXT | IMAGE | VIDEO | ...
  content: Record<string, unknown>;
  parentMessageId?: string;
  quoteData?: Record<string, unknown>;
  reactions: {
    emoji: string;
    count: number;
    users: { userId: string; displayName: string; avatar?: string }[];
  }[];
  isDeleted?: boolean;
  deletedType?: string;
  editedAt?: number;
  serverTs?: number;
  clientTs?: number;
  sequenceNumber: number;
  status?: "pending" | "sent" | "failed"; // client-only, for the optimistic bubble
};

type ChatState = {
  connection: "connecting" | "connected" | "recovered" | "disconnected";
  messagesByRoom: Record<string, ChatMessage[]>; // sorted by sequenceNumber
  typingByRoom: Record<string, Record<string, number>>; // roomId -> userId -> expiresAt(ms)
  presence: Record<string, { isOnline: boolean; lastSeen?: number }>;
  unreadByRoom: Record<string, number>;
  hiddenMessageIds: string[]; // forMe deletes (client-local)
};

const initialState: ChatState = {
  connection: "disconnected",
  messagesByRoom: {},
  typingByRoom: {},
  presence: {},
  unreadByRoom: {},
  hiddenMessageIds: [],
};

/** Insert/replace keeping the array sorted & deduped by sequenceNumber.
 *  Reconciles the optimistic bubble via clientMessageId. */
function upsertMessage(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const byClientId = msg.clientMessageId
    ? list.findIndex(
        (m) => m.clientMessageId && m.clientMessageId === msg.clientMessageId
      )
    : -1;
  const bySeq = list.findIndex(
    (m) => m.sequenceNumber === msg.sequenceNumber && msg.sequenceNumber > 0
  );
  const idx = byClientId !== -1 ? byClientId : bySeq;

  if (idx !== -1) {
    const next = [...list];
    next[idx] = { ...next[idx], ...msg, status: "sent" };
    return next.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }
  return [...list, msg].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

const chatSlice = createSlice({
  name: "chat",
  initialState,
  reducers: {
    setConnection(s, a: PayloadAction<ChatState["connection"]>) {
      s.connection = a.payload;
    },
    messageReceived(s, a: PayloadAction<ChatMessage>) {
      const m = a.payload;
      s.messagesByRoom[m.roomId] = upsertMessage(
        s.messagesByRoom[m.roomId] ?? [],
        m
      );
    },
    messagesLoaded(
      s,
      a: PayloadAction<{ roomId: string; messages: ChatMessage[] }>
    ) {
      const cur = s.messagesByRoom[a.payload.roomId] ?? [];
      const merged = [...cur];
      a.payload.messages.forEach((m) => {
        if (!merged.some((x) => x.sequenceNumber === m.sequenceNumber))
          merged.push(m);
      });
      s.messagesByRoom[a.payload.roomId] = merged.sort(
        (x, y) => x.sequenceNumber - y.sequenceNumber
      );
    },
    messageEdited(s, a: PayloadAction<ChatMessage>) {
      const m = a.payload;
      s.messagesByRoom[m.roomId] = upsertMessage(
        s.messagesByRoom[m.roomId] ?? [],
        m
      );
    },
    messageDeleted(
      s,
      a: PayloadAction<{
        roomId: string;
        messageId: string;
        type: "forEveryone" | "forMe";
        deletedBy: string;
        myUserId: string;
      }>
    ) {
      const { roomId, messageId, type, deletedBy, myUserId } = a.payload;
      // forEveryone: hide for all. forMe: hide only if I deleted it.
      if (type === "forEveryone" || deletedBy === myUserId) {
        if (!s.hiddenMessageIds.includes(messageId))
          s.hiddenMessageIds.push(messageId);
        const list = s.messagesByRoom[roomId];
        const t = list?.find((m) => m.id === messageId);
        if (t) {
          t.isDeleted = true;
        }
      }
    },
    reactionUpdated(
      s,
      a: PayloadAction<{
        roomId: string;
        messageId: string;
        reactions: ChatMessage["reactions"];
      }>
    ) {
      const list = s.messagesByRoom[a.payload.roomId];
      const m = list?.find((x) => x.id === a.payload.messageId);
      if (m) m.reactions = a.payload.reactions; // full current set — replace, don't merge
    },
    typingChanged(
      s,
      a: PayloadAction<{ roomId: string; userId: string; typing: boolean }>
    ) {
      const map = (s.typingByRoom[a.payload.roomId] ??= {});
      if (a.payload.typing) map[a.payload.userId] = Date.now() + 6000;
      else delete map[a.payload.userId];
    },
    presenceChanged(
      s,
      a: PayloadAction<{ userId: string; isOnline: boolean; lastSeen?: number }>
    ) {
      s.presence[a.payload.userId] = {
        isOnline: a.payload.isOnline,
        lastSeen: a.payload.lastSeen,
      };
    },
    markSendPending(s, a: PayloadAction<ChatMessage>) {
      const m = a.payload;
      s.messagesByRoom[m.roomId] = [...(s.messagesByRoom[m.roomId] ?? []), m];
    },
    markSendFailed(
      s,
      a: PayloadAction<{ roomId: string; clientMessageId: string }>
    ) {
      const m = s.messagesByRoom[a.payload.roomId]?.find(
        (x) => x.clientMessageId === a.payload.clientMessageId
      );
      if (m) m.status = "failed";
    },
  },
});

export const chatActions = chatSlice.actions;
export default chatSlice.reducer;
```

---

## 4. Wiring listeners — one provider

Register every server→client listener in a single mount-once effect. Use a stable
`mapMessage` so `message:new`, `message:edited`, and forwards all flow through one
mapper (they share the canonical `ChatMessage` shape).

```tsx
// components/SocketProvider.tsx
"use client";
import { useEffect } from "react";
import { useDispatch } from "react-redux";
import {
  initSockets,
  connectAll,
  disconnectAll,
  getSockets,
} from "@/lib/socket";
import { chatActions, type ChatMessage } from "@/store/chatSlice";

// Map the canonical server payload (with V1 aliases) into our ChatMessage.
function mapMessage(p: any): ChatMessage {
  return {
    id: p.id ?? p.messageId,
    clientMessageId: p.clientMessageId,
    roomId: p.roomId ?? p.conversationId,
    conversationType: (p.conversationType ?? "private").toLowerCase(),
    senderId: p.senderId,
    senderName: p.senderName,
    senderAvatar: p.senderAvatar,
    contentType: p.contentType, // UPPER-CASE
    content: p.content ?? { text: p.contentText, json: p.contentJson },
    parentMessageId: p.parentMessageId,
    quoteData: p.quoteData,
    reactions: p.reactions ?? [],
    isDeleted: p.isDeleted ?? false,
    deletedType: p.deletedType,
    editedAt: p.editedAt,
    serverTs: p.serverTs ?? p.sentAt,
    sequenceNumber: p.sequenceNumber,
    status: "sent",
  };
}

export function SocketProvider({
  getToken,
  myUserId,
  children,
}: {
  getToken: () => string | null;
  myUserId: string;
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();

  useEffect(() => {
    initSockets(getToken);
    const { chat, community, notify } = getSockets();

    // --- connection lifecycle ---
    chat.on("connect", () => {
      dispatch(
        chatActions.setConnection(chat.recovered ? "recovered" : "connected")
      );
      if (!chat.recovered) onFreshChatConnect(); // Tier-2 recovery (§7)
    });
    chat.on("disconnect", () =>
      dispatch(chatActions.setConnection("disconnected"))
    );
    chat.on("connect_error", (err) => {
      if (/Authentication/.test(err.message)) {
        /* refresh token then chat.connect() */
      }
    });

    // --- chat namespace ---
    chat.on("message:new", (p) =>
      dispatch(chatActions.messageReceived(mapMessage(p)))
    );
    chat.on("message:edited", (p) =>
      dispatch(chatActions.messageEdited(mapMessage(p)))
    );
    chat.on("message:delete", (p) =>
      dispatch(
        chatActions.messageDeleted({
          roomId: p.conversationId,
          messageId: p.messageId,
          type: p.type,
          deletedBy: p.deletedBy,
          myUserId,
        })
      )
    );
    chat.on("message:reaction", (p) =>
      dispatch(
        chatActions.reactionUpdated({
          roomId: p.conversationId,
          messageId: p.messageId,
          reactions: p.reactions,
        })
      )
    );
    chat.on("message:read", (p) => {
      /* mark peer's read HWM up to p.upToMessageId */
    });
    chat.on("message:delivered", (p) => {
      /* mark delivered up to p.upToMessageId */
    });
    chat.on("read_sync", (p) => {
      /* my other device read — clear unread for p.conversationId */
    });
    // p.userDetails ({ username, displayName, avatarUrl }) is resolved
    // server-side at connect — render "Alice is typing…" with an avatar from
    // p.userDetails.displayName / p.userDetails.avatarUrl, no profile fetch.
    chat.on("typing:start", (p) =>
      dispatch(
        chatActions.typingChanged({
          roomId: p.conversationId,
          userId: p.userId,
          displayName: p.userDetails.displayName,
          avatarUrl: p.userDetails.avatarUrl,
          typing: true,
        })
      )
    );
    chat.on("typing:stop", (p) =>
      dispatch(
        chatActions.typingChanged({
          roomId: p.conversationId,
          userId: p.userId,
          typing: false,
        })
      )
    );
    chat.on("presence:status", (p) => dispatch(chatActions.presenceChanged(p)));
    chat.on("pin:updated", (p) => {
      /* update pinned banner — pinnedCount/action */
    });

    // list/inbox bump-to-top (delivered to user:<id>)
    chat.on("conv:updated", (p) => {
      /* splice room to top of inbox, key roomId */
    });

    // catch-up results (one per room)
    chat.on("chat:catchup:result", (p) =>
      dispatch(
        chatActions.messagesLoaded({
          roomId: p.roomId,
          messages: (p.events ?? []).map(mapMessage),
        })
      )
    );

    // --- community namespace ---
    community.on("community:message:new", (p) => {
      /* dispatch into community store */
    });
    // community list bump-to-top (delivered to user:<id> on /community)
    community.on("community:updated", (p) => {
      /* splice community to top, key communityId */
    });
    community.on("community:message:reaction", (p) => {
      /* full reaction set */
    });
    community.on("community:message:edited", (p) => {
      /* re-render bubble */
    });
    community.on("community:message:deleted", (p) => {
      /* forEveryone tombstone */
    });
    community.on("community:message:pinned", (p) => {
      /* replace pinnedIds */
    });
    community.on("community:message:unpinned", (p) => {
      /* replace pinnedIds */
    });
    community.on("community:catchup:result", (p) => {
      /* reconcile by syncEventType */
    });

    // --- notify namespace ---
    notify.on("notification:count", (p) => {
      /* set badge = p.count */
    });
    notify.on("notification:count_update", (p) => {
      /* replace badge = p.count */
    });
    notify.on("notification:new", (p) => {
      /* prepend feed; read p.notificationId ?? p.id */
    });

    connectAll();
    return () => disconnectAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <>{children}</>;
}
```

Mount it inside your providers tree (below the Redux `<Provider>` and TanStack
`QueryClientProvider`), passing the current token and user id.

---

## 5. Joining a conversation & loading history

Rooms are **per-socket and server-computed** — you never send `userId`. Join on
open, leave on close. Both are idempotent.

```tsx
// hooks/useConversation.ts
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDispatch } from "react-redux";
import { getSockets } from "@/lib/socket";
import { emitAck } from "@/lib/socket/emit";
import { chatActions } from "@/store/chatSlice";

export function useConversation(
  conversationId: string,
  conversationType: "private" | "group"
) {
  const dispatch = useDispatch();
  const { chat } = getSockets();

  // First page of history via the socket (cursor-paged, limit ≤ 100).
  const history = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: async () => {
      const res = await emitAck<{ messages: any[]; nextCursor?: string }>(
        chat,
        "messages:fetch",
        { conversationId, limit: 50, conversationType }
      );
      if (!res.success) throw new Error(res.message);
      return res.data!;
    },
  });

  useEffect(() => {
    let active = true;
    emitAck(chat, "conv:join", { conversationId }).then((res) => {
      if (!active || !res.success) return;
    });
    if (history.data?.messages) {
      dispatch(
        chatActions.messagesLoaded({
          roomId: conversationId,
          messages: history.data.messages,
        })
      );
    }
    return () => {
      active = false;
      emitAck(chat, "conv:leave", { conversationId });
    };
  }, [conversationId]); // eslint-disable-line

  return history;
}
```

> `conv:join` is idempotent and always `success:true`; membership / NOT_FOUND /
> FORBIDDEN are enforced at `message:send` time, not at join. Use
> `messages:fetch` (cursor pagination, `limit ≤ 100`) for scroll-back history.

---

## 6. Sending a message (optimistic + idempotent)

`clientMessageId` is your **idempotency key** — the server dedupes on it, so a
replayed/retried send never creates a duplicate (`alreadySent:true`). Render the
bubble optimistically with `clientTs`, then reconcile on ack.

```ts
// hooks/useSendMessage.ts
import { v4 as uuid } from "uuid";
import { useDispatch } from "react-redux";
import { getSockets } from "@/lib/socket";
import { emitAck, type Ack } from "@/lib/socket/emit";
import { chatActions } from "@/store/chatSlice";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useSendMessage(myUserId: string) {
  const dispatch = useDispatch();
  const { chat } = getSockets();

  return async function send(opts: {
    conversationId: string;
    conversationType: "private" | "group";
    contentText?: string;
    files?: any[];
    repliedToId?: string;
    receiverId?: string;
  }) {
    const clientMessageId = uuid();
    const clientTs = Date.now();

    // 1. optimistic bubble (sequenceNumber 0 until the server assigns one)
    dispatch(
      chatActions.markSendPending({
        id: clientMessageId,
        clientMessageId,
        roomId: opts.conversationId,
        conversationType: opts.conversationType,
        senderId: myUserId,
        contentType: opts.files?.length ? "IMAGE" : "TEXT",
        content: { text: opts.contentText },
        reactions: [],
        sequenceNumber: 0,
        clientTs,
        status: "pending",
      })
    );

    const payload = {
      conversationId: opts.conversationId,
      clientMessageId,
      contentType: opts.files?.length ? "IMAGE" : "TEXT",
      contentText: opts.contentText,
      files: opts.files,
      repliedToId: opts.repliedToId,
      conversationType: opts.conversationType,
      receiverId: opts.receiverId,
    };

    // 2. send with retry policy (§8 of the contract)
    const res = await sendWithRetry(() =>
      emitAck(chat, "message:send", payload)
    );

    if (res.success) {
      // message:new echo will reconcile the bubble by clientMessageId — nothing else to do.
      return res.data;
    }
    dispatch(
      chatActions.markSendFailed({
        roomId: opts.conversationId,
        clientMessageId,
      })
    );
    return null;
  };

  async function sendWithRetry(
    fn: () => Promise<Ack>,
    attempt = 1
  ): Promise<Ack> {
    const res = await fn();
    if (res.success || !res.retryable) return res;
    if (res.error === "RATE_LIMITED") {
      const retryAfter = (res as any).retryAfter as number | undefined;
      await sleep(retryAfter ? Math.max(0, retryAfter - Date.now()) : 30_000);
      return fn(); // one retry
    }
    if (res.error === "SERVICE_ERROR" && attempt < 3) {
      await sleep(Math.min(500 * 2 ** (attempt - 1), 30_000)); // 500ms → 1s → 2s
      return sendWithRetry(fn, attempt + 1);
    }
    return res;
  }
}
```

**Retry policy (mirror the contract §8.5):**

- `SERVICE_ERROR` → exponential backoff 500 ms → 1 s → 2 s (cap 30 s), **max 3
  attempts**, resend with the **same** `clientMessageId`.
- `RATE_LIMITED` → wait until `retryAfter` (epoch-ms) if present, else 30 s, then
  **one** retry. Never retry before `retryAfter`.
- `INVALID_PAYLOAD` / `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` → **do not retry**;
  surface to the user / drop.

**Media:** never put bytes on the socket. Presign → `PUT` to MinIO → send the
returned `objectKey` inside `files[]`. See [`MEDIA_UPLOAD.md`](MEDIA_UPLOAD.md).

**Offline queue:** persist un-acked sends locally (IndexedDB) keyed by
`clientMessageId`, flush **FIFO per conversation** on reconnect — replay is safe
because the server is idempotent.

---

## 7. Reconnection & catch-up

Two tiers. Handle both.

**Tier 1 — `connectionStateRecovery` (≤ 2 min).** If `socket.recovered === true`
on `connect`, rooms are auto-rejoined and buffered emits replayed. **Do nothing**
— don't re-join, don't re-subscribe.

**Tier 2 — beyond 2 min / fresh session.** The session is gone. You must:

1. Re-`conv:join` / `community:join` every open room.
2. Re-`presence:subscribe` watched peers.
3. Gap-fill via `chat:catchup` (per room, `sinceSeq` = highest `sequenceNumber`
   you've stored). `/chat` accepts **≤ 50 rooms** per call; `/community`
   `community:catchup` **≤ 20**. Batch beyond the cap.

```ts
// called from chat.on("connect") when !chat.recovered
async function onFreshChatConnect() {
  const { chat } = getSockets();
  const openRooms = getOpenRooms(); // your app state
  const cursors = loadCursors(); // persisted: roomId -> highest sequenceNumber

  await Promise.all(
    openRooms.map((r) => emitAck(chat, "conv:join", { conversationId: r.id }))
  );
  await emitAck(chat, "presence:subscribe", { peerIds: getWatchedPeers() });

  // batch ≤ 50 rooms per call
  for (let i = 0; i < openRooms.length; i += 50) {
    const batch = openRooms.slice(i, i + 50).map((r) => ({
      roomId: r.id,
      sinceSeq: cursors[r.id] ?? 0,
      conversationType: r.type,
    }));
    await emitAck(chat, "chat:catchup", { rooms: batch });
    // chat:catchup:result arrives per room (handled by the listener);
    // if a result has hasMore:true, re-emit chat:catchup with sinceSeq = lastSeq.
  }
}
```

> **Persist cursors yourself.** After every message / catch-up page, store the
> highest `sequenceNumber` per room. Catch-up **includes tombstones**
> (deleted/edited rows) so you can reconcile offline state. When
> `chat:catchup:result.hasMore` is true, re-request that room with
> `sinceSeq = lastSeq` until `hasMore` is false.

**Backoff:** use Socket.IO client defaults (exponential, 1 s → 5 s). Never a
fixed-interval retry loop.

---

## 8. Receipts, typing, presence

**Delivery receipt (private only).** On receiving `message:new` for a 1-1 chat,
emit `message:delivered { conversationId, upToMessageId }`. Group/community have
**no** per-member delivery receipt — sent + read only.

**Read receipt.** When the user views the conversation, emit
`message:read { conversationId, upToMessageId }`. Peers get `message:read`; your
own other devices get `read_sync` (multi-device unread clear).

**Typing.** Fire-and-forget (no ack, validate client-side). Throttle
`typing:start` to **≤ 1 per 3 s** per conversation; debounce `typing:stop`.

```ts
// hooks/useTyping.ts
import { useRef } from "react";
import { getSockets } from "@/lib/socket";

export function useTyping(conversationId: string) {
  const { chat } = getSockets();
  const last = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout>>();

  function onInput() {
    const now = Date.now();
    if (now - last.current > 3000) {
      // ≤ 1 per 3s
      chat.emit("typing:start", { conversationId });
      last.current = now;
    }
    clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(stop, 4000); // stop ~4s after last keystroke
  }
  function stop() {
    chat.emit("typing:stop", { conversationId });
    last.current = 0;
  }
  return { onInput, stop };
}
```

> The **receiver** must also expire its own "typing…" after ~6 s with no fresh
> `typing:start` (the server also auto-expires after 6 s, but expire client-side
> too). The `typingByRoom` map stores `expiresAt`; filter it on render.

> **Enriched broadcast.** The listen payload is now
> `{ conversationId, userId, userDetails, timestamp, senderName }`. Render the
> indicator straight from `p.userDetails.displayName` / `p.userDetails.avatarUrl`
> (`avatarUrl` may be `null`) — **no profile fetch needed**. `userId` is
> server-authoritative; `senderName` mirrors `displayName` for legacy clients;
> `timestamp` is an **epoch-ms number** (all socket timestamps, including
> `conv:archived.archivedAt`, are epoch ms — never ISO strings). The same shape
> arrives on the server's 6 s auto-expiry stop and the disconnect-flush stop.

**Community typing.** Identical UX on the `/community` namespace — emit
`typing:start { communityId }` / `typing:stop { communityId }` (throttle the same
way), and listen for the same enriched broadcast on `community.on("typing:start"|"typing:stop")`.
The broadcast carries both `communityId` and `conversationId` (set equal to the
communityId) plus `userDetails`/`timestamp`.

```ts
const { community } = getSockets();
community.emit("typing:start", { communityId }); // throttled ≤ 1 per 3s
community.on("typing:start", (p) =>
  showTyping(p.communityId, p.userDetails.displayName, p.userDetails.avatarUrl)
);
community.on("typing:stop", (p) => hideTyping(p.communityId, p.userId));
```

**Presence.** Subscribe to peers you display; heartbeat to stay online.

```ts
const { chat } = getSockets();
await emitAck(chat, "presence:subscribe", { peerIds: [friendId] }); // ≤ 500 ids
// receive presence:status { userId, isOnline, lastSeen } in the listener
// heartbeat: ≤ 1 per 30–60s in foreground; do NOT heartbeat in background
const hb = setInterval(
  () => chat.emit("presence:heartbeat", { appState: "FOREGROUND" }),
  45_000
);
// on unmount: clearInterval(hb); emitAck(chat, "presence:unsubscribe", { peerIds: [friendId] });
```

---

## 9. Reactions, edit, delete, forward

```ts
const { chat } = getSockets();

// toggle a reaction (same emoji again removes it); ≤ 10/min per conversation
await emitAck(chat, "message:react", {
  messageId,
  conversationId,
  emoji: "👍",
});
// → broadcast message:reaction carries the FULL current set; replace, don't merge.
// selfReacted is derived client-side: reactions[].users[].userId === myUserId

// edit own message (REST PATCH is authoritative; socket is the broadcast)
await emitAck(chat, "message:edit", {
  messageId,
  conversationId,
  contentText,
  conversationType,
});
// → message:edited (same canonical shape as message:new — one mapper)

// forward into another conversation
await emitAck(chat, "message:forward", {
  messageId,
  targetConversationId,
  clientMessageId: uuid(),
  conversationType,
});
// → message:new with isForwarded:true in the target room
```

**Delete** is REST-authoritative (`DELETE …/messages/:id`); the socket
`message:delete` is the broadcast. Apply the self-describing payload:
`forEveryone` → hide for all; `forMe` → hide only when `deletedBy === myUserId`
(track your own `hiddenMessageIds` locally — catch-up may still return the row).

---

## 10. Community & notifications (quick reference)

**Community** (`/community` namespace) mirrors chat but uses ISO-8601 cursors and
`id`/`ts` catch-up instead of `sequenceNumber`:

```ts
const { community } = getSockets();
await emitAck(community, "community:join", { communityId, roomId });
await emitAck(community, "community:message:send", {
  communityId,
  roomId,
  clientMessageId: uuid(),
  message,
  contentType: "TEXT",
});
await emitAck(community, "community:messages:fetch", { roomId, limit: 30 }); // cursor: ISO8601-UTC, past only
await emitAck(community, "community:catchup", {
  rooms: [{ roomId, sinceId, limit: 100 }],
}); // ≤ 20 rooms
// pin/unpin broadcasts send the COMPLETE pinnedIds list — replace, don't merge
```

> **List bump for communities arrives on `/community`**, not `/chat` — listen for
> `community:updated` on the community socket. The private/group inbox bump
> `conv:updated` still arrives on the chat socket (the unified inbox uses the chat
> socket). Community message **deletes** broadcast as `message:delete` on
> `conv:<roomId>`.

**Notifications** (`/notify`): on connect you get `notification:count` once; new
items arrive as `notification:new` (read `notificationId ?? id`); the badge total
updates via `notification:count_update` across all devices. Mark read with
`notifications:mark_read { notificationIds }`.

> **REST-only, surfaced via `/notify`:** friend requests/accepts
> (`friend.requested` / `friend.accepted`), community moderation
> (`community.member_kicked`, `community.member_banned`, …). There are no socket
> events for those actions — do them over REST and react to the notification.

---

## 11. 1-1 calls (WebRTC signaling)

The backend is **signaling-only** — media flows P2P / via TURN (`rtcConfig` from
the `call:initiate` ack). V1 is **1-1 only**.

```ts
const { chat } = getSockets();
// caller
const res = await emitAck(chat, "call:initiate", {
  calleeId,
  callType: "VIDEO",
});
// res.data: { callId, status, rtcConfig } — feed rtcConfig into RTCPeerConnection
// callee receives call:incoming { callId, callerId, callType } on user:<calleeId>
await emitAck(chat, "call:answer", { callId }); // → call:answered to call:<callId>
// or emitAck(chat, "call:decline", { callId });  // → call:declined
chat.emit("call:ice", { callId, candidate }); // fire-and-forget, both sides
await emitAck(chat, "call:end", { callId }); // → call:ended { endedBy, durationSec }
```

> **Caller cancel (V1):** emit `call:end` before the callee answers → callee sees
> `call:ended { durationSec:0 }`. `call:cancel` / `call:missed` are V2. Auto-cancel
> after ~60 s ringing is the caller's responsibility in V1.

---

## 12. Gotchas checklist

- **Sort & dedupe by `sequenceNumber`**, never by arrival time or `serverTs`.
- **Cross-channel events have no ordering guarantee** — `conv:updated` (on
  `user:<id>`) may arrive before its `message:new` (on `conv:<id>`). Handle
  out-of-order defensively.
- **A user inside a conversation gets both** `message:new` (append in-room) **and**
  `conv:updated` (reorder list) — handle independently; both are idempotent.
- **Ack numerics are numbers** (`sentAt`, `sequenceNumber`, …) — same as
  broadcasts; the gateway coerces the gRPC int64 wire-strings.
- **`contentType` is always UPPER-CASE** on every surface; call type uses
  `callType` (`"AUDIO"`/`"VIDEO"`).
- **Never double-apply** your own REST edit/delete and its socket echo
  (last-write-wins on the same row).
- **No `conv:created`/`conv:deleted` events** — after REST create/delete, refetch
  `GET /api/v1/chat/inbox` and `conv:join` new rooms explicitly.
- **Background:** emit `presence:heartbeat { appState:"BACKGROUND" }`, stop the
  foreground heartbeat, treat the socket as gone; new messages arrive via push.

---

## 13. Event cheat-sheet

**Emit (client → server, `/chat`):** `conv:join` · `conv:leave` · `message:send` ·
`message:read` · `message:delivered` · `message:react` · `message:reactions:get` ·
`message:edit` · `message:forward` · `messages:fetch` · `chat:catchup` ·
`typing:start` · `typing:stop` · `presence:heartbeat` · `presence:subscribe` ·
`presence:unsubscribe` · `presence:unsubscribe_all` · `presence:list` ·
`call:initiate` · `call:answer` · `call:decline` · `call:end` · `call:ice`

**Listen (server → client, `/chat`):** `message:new` · `message:edited` ·
`conv:updated` · `chat:catchup:result` · `message:read` ·
`message:delivered` · `message:reaction` · `message:delete` · `read_sync` ·
`pin:updated` · `typing:start` · `typing:stop` · `presence:status` ·
`call:incoming` · `call:answered` · `call:declined` · `call:ended` · `call:ice`

**Listen (server → client, `/community`):** `community:message:new` ·
`community:message:reaction` · `community:message:edited` ·
`community:message:deleted` · `community:message:pinned` ·
`community:message:unpinned` · `community:updated` (community list bump-to-top)

**Typing (client ↔ server, `/community`):** emit `typing:start` · `typing:stop`
(`{ communityId }`); listen `typing:start` · `typing:stop` (enriched broadcast
with `userDetails`/`timestamp`, room `community:<communityId>`).

See [`SOCKET_EVENTS.md`](SOCKET_EVENTS.md) §10 for the full index including
`/community` and `/notify`.
