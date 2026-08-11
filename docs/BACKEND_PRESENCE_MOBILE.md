# AIMess Presence — Mobile / Client Contract

WhatsApp-style **Online / Offline + Last seen** for private chats.

This document describes the contract as **implemented**, not as proposed. Every
event name, field and endpoint below exists in the code.

- Socket namespace: `/chat`
- Event: `presence:status`
- REST: `GET /api/v1/chat/private/presence/{userId}`
- Hydration also rides on the conversation list and room-details responses.

---

## 1. Presence states

There are exactly two.

| State     | Meaning                                                     |
| --------- | ----------------------------------------------------------- |
| `ONLINE`  | The user has at least one live, valid session.              |
| `OFFLINE` | The user has none. `lastSeenAt` is when the last one ended. |

Presence is derived **only** from active sessions. It is _not_ derived from
sending a message, typing, opening a chat, read receipts, `lastActivity`, or
having a conversation on screen.

> `lastActivity` (conversation activity) and `lastSeen` (a person's presence)
> are different concepts and are never interchangeable.

---

## 2. The event

### `presence:status` (server → client, `/chat`)

```jsonc
{
  "userId": "user_abc123",
  "isOnline": false,
  "lastSeen": 1749465700000, // server epoch ms
  "lastActiveAt": 1749465700000, // legacy; prefer lastSeen
  "version": 42,
}
```

| Field          | Type              | Notes                                                                         |
| -------------- | ----------------- | ----------------------------------------------------------------------------- |
| `userId`       | string            | The subject.                                                                  |
| `isOnline`     | boolean           | Authoritative.                                                                |
| `lastSeen`     | integer \| null   | **Server-generated** epoch ms. Render only while `isOnline` is false.         |
| `lastActiveAt` | integer           | Pre-existing field, kept for compatibility. Do not build new behaviour on it. |
| `version`      | integer, optional | Monotonic per user. See §7.                                                   |

**Emitted only on a real transition.** It is never a keepalive, and it is never
re-sent for a state you already have. If nothing changed, nothing is published —
which is why hydration (§5) is mandatory and not an optimisation.

**Delivery is scoped.** It is published on `user:<subjectId>` and mirrored by the
gateway to the Socket.IO room `presence:<subjectId>` — a room a client only joins
after passing the `whoCanSeeOnlineStatus` check. It is never broadcast.

---

## 3. Watching a peer

### `presence:subscribe` (client → server, with ack)

```jsonc
// emit
{ "peerIds": ["user_abc123", "user_def456"] }
```

```jsonc
// ack
{
  "success": true,
  "data": {
    "subscribedCount": 2,
    "statuses": [
      {
        "userId": "user_abc123",
        "isOnline": true,
        "lastSeen": null,
        "version": 42,
      },
      {
        "userId": "user_def456",
        "isOnline": false,
        "lastSeen": 1749465700000,
        "version": 17,
      },
    ],
  },
}
```

**The ack carries the current state.** Apply `statuses` exactly as you would
apply `presence:status` events. This is the reconcile point (§6) — it is how a
change you missed while disconnected is corrected.

Peers you are not allowed to see are silently omitted from `statuses` and from
`subscribedCount`. There is no per-peer error: that would itself disclose the
setting.

Batch up to ~500 peer ids per call.

### `presence:unsubscribe` — `{ "peerIds": [...] }`

### `presence:unsubscribe_all` — `{}`; ack `{ unsubscribedCount }`

### `presence:list` — `{}`; ack `{ peerIds }` (peers this socket currently watches)

---

## 4. Heartbeat — what the client must and must not do

**Liveness is server-driven.** The gateway refreshes your device session from
traffic on the socket itself, including the transport's own ping/pong. A client
that never sends an application-level heartbeat **does not** go offline while
its socket is open.

### `presence:heartbeat` (client → server, fire-and-forget)

```jsonc
{ "appState": "FOREGROUND" } // or "BACKGROUND"
```

Send it:

- when the app moves to background → `{"appState": "BACKGROUND"}`
- when it returns to foreground → `{"appState": "FOREGROUND"}`

An app-state **change** is applied immediately (not throttled). Sending it on a
30–60 s timer as well is harmless and still supported.

### Server-side timing

| Knob                          | Default | Meaning                                                  |
| ----------------------------- | ------- | -------------------------------------------------------- |
| `PRESENCE_REFRESH_MS`         | 45 s    | Gateway refreshes each live socket's session this often. |
| `PRESENCE_SESSION_TTL_SEC`    | 150 s   | A session is believed live this long without a refresh.  |
| `PRESENCE_SWEEP_INTERVAL_SEC` | 30 s    | How often stale sessions are re-derived and published.   |
| background grace              | 5 min   | A `BACKGROUND` session still counts as online this long. |

A user is ONLINE while any session is `FOREGROUND`, **or** `BACKGROUND` and
active within the grace window.

**Unclean disappearance** (process killed, dead TCP, a crashed server node) is
handled: the session TTL lapses, the sweep notices, and an OFFLINE with a
server-stamped `lastSeen` is published. Worst case ≈ TTL + sweep interval
(~3 min). No client action is required, and nobody is left "Online forever".

---

## 5. Hydration — opening a chat, and first paint

Do **not** wait for a `presence:status` after opening a conversation. If the peer
is already offline, no event is coming, because nothing changed.

Three responses already carry presence; use whichever you were already calling:

| Source                                            | Fields                              |
| ------------------------------------------------- | ----------------------------------- |
| `GET /chat/private/conversations` (inbox)         | `peer.isOnline`, `peer.lastSeen`    |
| `GET /chat/private/rooms/{peerId}` (room details) | `isOnline`, `isOffline`, `lastSeen` |
| `GET /chat/private/presence/{userId}`             | `isOnline`, `lastSeen`, `version`   |
| `presence:subscribe` ack                          | `statuses[]` (see §3)               |

All of these are **viewer-scoped** — already masked by the subject's privacy
settings — so they can be rendered directly.

---

## 6. Reconnect / missed events

Socket events are realtime delivery, not durable state. After any reconnect:

1. Re-emit `presence:subscribe` for the peers on screen (room subscriptions do
   not survive a new connection).
2. Apply the ack's `statuses`.

That is the whole recovery path. No extra endpoint, no full reload.

---

## 7. Stale / out-of-order events

`version` is a per-user counter that advances **only** on a real
ONLINE↔OFFLINE flip, assigned atomically in Redis so concurrent server replicas
cannot produce disagreeing orders.

Client rule:

```
if (incoming.version != null && incoming.version > 0 &&
    stored?.version != null && incoming.version < stored.version) {
  drop;            // arrived late — do not resurrect the older state
} else {
  apply;
}
```

**A `presence:status` with NO `version` must be applied unconditionally.** The
server omits it when _revoking_ presence visibility (you unfriended the peer,
or they changed their privacy setting). Version-guarding that message would
leave a green dot lit for a viewer no longer entitled to see it.

Snapshots from REST carry the same counter, so they compare directly against
events with no special case.

---

## 8. Multi-device

Presence is per **socket**, not per login. Two tabs of one browser session, or a
phone plus a desktop, are independent sessions.

| Transition                       | Result                                   |
| -------------------------------- | ---------------------------------------- |
| 0 sessions → 1                   | OFFLINE → **ONLINE**, event published    |
| 1+ sessions, one more added      | stays ONLINE, **no event**               |
| 2 sessions → 1 (e.g. web closes) | stays **ONLINE**, **no event**           |
| 1 session → 0                    | ONLINE → **OFFLINE** + `lastSeen`, event |

`lastSeen` is stamped when the **last** session ends — never on an intermediate
disconnect, so it can't drift while the user is still online on another device.

Closing one browser tab must not, and does not, mark the user offline.

---

## 9. Last seen

- Always **server-generated**. Client clocks are never trusted or used.
- Epoch **milliseconds** (integer), the standard AIMess private-chat timestamp
  format — not ISO strings.
- Retained ~30 days.
- `null` means "never recorded", not "just now". Render a plain "Offline".

Suggested rendering (this is what the web client does, via the shared i18n
catalog — do not hard-code English):

| Age          | Example                         |
| ------------ | ------------------------------- |
| < 1 min      | Last seen just now              |
| < 1 hour     | Last seen 5 minutes ago         |
| same day     | Last seen today at 2:35 PM      |
| previous day | Last seen yesterday at 11:20 AM |
| older        | Last seen Aug 3 at 11:20 AM     |

---

## 10. Privacy and authorization

Governed by the existing **`whoCanSeeOnlineStatus`** setting
(`EVERYONE` / `FRIENDS` / `NO_ONE`; default `FRIENDS`). It is enforced on every
surface — socket subscribe, REST presence, room details, conversation list —
and it **fails closed**: if the check cannot be completed, the answer is
"offline".

- A denied viewer receives `{ isOnline: false, lastSeen: null }` — byte-for-byte
  what a genuinely offline user returns, so the setting itself is not inferable.
- Sharing a DM room is **not** consent to see presence. A stranger or an
  ex-friend still fails the gate.
- Visibility is re-evaluated live. Unfriending, blocking, or changing the
  setting pushes an immediate OFFLINE to revoked watchers and removes them from
  the room; becoming friends (or being unblocked) joins newly-allowed watchers
  and pushes the true current state. Neither requires a client re-subscribe.
- Presence never rides a global namespace or an unscoped broadcast. A user with
  no access receives nothing at all.

---

## 11. Friendship edge cases

- **Request → accept, before any message exists.** Presence works immediately;
  it does not depend on a conversation, a room, or a system message.
- **Unfriend.** Under the default `FRIENDS` scope, presence access is revoked
  and the watcher is pushed OFFLINE at once.
- **Re-friend.** Access is re-granted and the true state is pushed at once.

---

## 12. QA scenarios

| #   | Scenario                                             | Expected                                                       |
| --- | ---------------------------------------------------- | -------------------------------------------------------------- |
| 1   | B connects while A has B's chat open                 | A sees **Online**, no refresh                                  |
| 2   | B disconnects last device                            | A sees **Last seen …**, no refresh                             |
| 3   | B has web + mobile; web disconnects                  | B stays **Online**; no event emitted                           |
| 4   | B's mobile disconnects too                           | B goes **Offline**, `lastSeen` stamped                         |
| 5   | B reconnects                                         | A sees **Online** immediately                                  |
| 6   | A loses socket; B flips online→offline; A reconnects | A's `presence:subscribe` ack returns the correct current state |
| 7   | Events arrive out of order                           | Lower `version` is dropped; state never regresses              |
| 8   | Compare conversation list vs chat header             | Identical — both read one store fed by one event               |
| 9   | Two browser tabs; close one                          | User stays **Online**                                          |
| 10  | Kill the app with no clean disconnect                | OFFLINE within ~TTL + sweep (~3 min), with `lastSeen`          |
| 11  | Unauthorized user subscribes to a peer               | Silently not joined; `statuses` omits them; no events ever     |
| 12  | Unfriend, then re-friend                             | Revoked → OFFLINE at once; re-granted → true state at once     |

---

## 13. Implementation notes (server side, for reference)

- Canonical state lives in Redis: `presence:user:{<id>}`,
  `presence:lastseen:{<id>}`, `presence:ver:{<id>}` — written together by one
  atomic script, so status and version can never disagree.
- Device sessions: `presence:device:{<id>}:<socketId>`, TTL
  `PRESENCE_SESSION_TTL_SEC`.
- `presence:online` (ZSET, score = staleness deadline) drives the sweep.
- The old presence-carrying `conv:updated` fan-out (`isOffline` on a
  presence flip) has been **removed**. `conv:updated` is a conversation-list
  bump; presence now travels on `presence:status` only. `conv:updated` emitted
  for an actual _message_ still carries `isOffline` as before — that path is
  unchanged.
