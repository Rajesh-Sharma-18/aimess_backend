# Livestream ended: who is named as the actor (Android)

Backend status: **shipped** on `rajesh-dev`. The wording is unchanged. Only the actor named in the sentence changes, according to who pressed End Live.

## Current problem

When a Super Admin ended a livestream from Backoffice, every surface read "System ended the livestream". A community admin's End for Everyone named the admin in the chat line, but the stream host never received the push.

## Actor mapping

| Who pressed End Live | Chat line (`content.text`) | Push / notification body |
|---|---|---|
| Host | `{Host} ended the livestream (4m)`, and the host reads `You ended the livestream (4m)` | `{Host} ended the livestream in {Community} after 4m` |
| Community admin (End for Everyone) | `{Admin} ended {Host}'s livestream (4m)`, and that admin reads `You ended {Host}'s livestream (4m)` | `{Admin} ended {Host}'s livestream in {Community} after 4m` |
| Super Admin (Backoffice) | `Administrator ended {Host}'s livestream (4m)`; the host reads `Administrator ended the livestream (4m)` | `Administrator ended {Host}'s livestream in {Community} after 4m`; the host gets `Administrator ended the livestream in {Community} after 4m` |
| Platform (moderation, ban, timeout) | `System ended the livestream (4m)` (unchanged) | `System ended the livestream in {Community} after 4m` (unchanged) |

The `You ended…` form for the actor's own chat line already existed (`SYS_COMMUNITY_LIVESTREAM_ENDED_SELF`). It was not added by this change.

## Payload

- `community:message:new` / history / sync, `systemMessageType = "LIVE_STREAM_ENDED"`:
  - `systemMetadata.endedReason` is one of `"USER"`, `"ADMIN"` (**new**) or `"SYSTEM"`. It is absent on legacy rows, so treat a missing value as `USER`.
  - `actorUserId` / `actorName` name the person who ended it (the host, or the community admin) for `USER`. For `ADMIN` and `SYSTEM` they stay the host: `ADMIN` uses `actorName` only as the host in "Administrator ended {host}'s livestream", and `SYSTEM` never renders it.
  - `targetUserId` / `targetName` are set only when a community admin ended someone else's stream. They are the host.
  - `hostUserId` always identifies the stream owner.
  - The Super Admin's id and name are never sent to apps.
- Push / inbox `data` for `community.livestream_ended`:
  - `endedReason` is `"USER"`, `"ADMIN"` (**new**) or `"SYSTEM"`.
  - `hostUserId` / `hostName` identify the stream owner, not necessarily the actor.
  - `actorSnapshot` is the community admin on an admin End for Everyone, and the host otherwise.

## UI text rules

1. Prefer the server's `content.text` for the chat line and `lastActivity.preview` for the list. Both are already rendered per viewer and per locale.
2. If you compose the line locally, branch on `endedReason`:
   - `ADMIN` → "Administrator ended {actorName}'s livestream" ("Administrator ended the livestream" if the name is empty, or if `hostUserId` — `actorUserId` on older rows — is the current user). Never "You" or "System".
   - `SYSTEM` → "System ended the livestream".
   - `targetName` present → "You ended {targetName}'s livestream" when `actorUserId == me`, else "{actorName} ended {targetName}'s livestream".
   - Otherwise: "You ended the livestream" when `actorUserId == me`, else "{actorName} ended the livestream".
3. **Treat an unknown `endedReason` as "render `content.text`"**, never as `USER`. Treating it as `USER` names the host as the actor, which is wrong.
4. Never derive the actor from `hostUserId` or `hostName`.
5. Add these strings to `strings.xml` for every locale: en "Administrator ended {host}'s livestream" / "{actor} ended {host}'s livestream", vi "Quản trị viên đã kết thúc buổi phát trực tiếp của {host}" / "{actor} đã kết thúc buổi phát trực tiếp của {host}", th "ผู้ดูแลระบบจบไลฟ์สตรีมของ{host}" / "{actor}จบไลฟ์สตรีมของ{host}".

## Push rules (server-side, for reference)

- The actor never receives a push or inbox row about their own End Live: the host on their own end, the community admin on End for Everyone.
- The host **does** get the push when a community admin or a Super Admin ends their stream.
- Realtime is untouched. Everyone in the community, the actor included, still gets `community:stream:ended` and `stream:status ENDED`, so close the player on those events as before.
- The stream-mute preference and the `liveStreamEnabled` category are still respected.

## Backward compatibility

Older app builds that compare only `endedReason == "SYSTEM"` would show the host's name for `ADMIN`. Ship rule 3 above, or render `content.text`.

## Test matrix

| # | Action | Host sees | Admin sees | Other moderator / member sees | Push recipients |
|---|---|---|---|---|---|
| 1 | Host ends | You ended… | {Host} ended… | {Host} ended… | everyone except the host |
| 2 | Community admin ends | {Admin} ended {Host}'s… | You ended {Host}'s… | {Admin} ended {Host}'s… | everyone except that admin, host included |
| 3 | Super Admin ends | Administrator ended {Host}'s… | Administrator ended the livestream… | Administrator ended {Host}'s… | everyone, host included |
| 3b | Super Admin ends a community ADMIN's stream | Administrator ended {Admin host}'s… | Administrator ended the livestream… | Administrator ended {Admin host}'s… | everyone, host included |
| 4 | Reopen the chat or relaunch after 1–3 | same text from history | same | same | |
| 5 | Stream-muted member, any case | n/a | n/a | n/a | no push for them |
