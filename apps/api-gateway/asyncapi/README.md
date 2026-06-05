# AIMess Real-time API — AsyncAPI

Machine-readable spec of every Socket.IO event the **api-gateway** exposes
(`/chat`, `/community`, `/notify`), authored in [AsyncAPI 3.0](https://www.asyncapi.com/).

> Pinned to **3.0.0** (not 3.1.0): the `@asyncapi/react-component` viewer bundle
> served at `/docs/socket` only supports up to 3.0.0. The CLI validates both.

- **Spec file:** [`asyncapi.yaml`](./asyncapi.yaml)
- **Human-readable source of truth:** [`docs/SOCKET_EVENTS.md`](../../../docs/SOCKET_EVENTS.md)
- **Gateway socket code:** [`src/sockets/`](../src/sockets/)

If the code and this spec disagree, **code wins** — then update `asyncapi.yaml`
and `docs/SOCKET_EVENTS.md` in the same PR.

## Modelling conventions

Socket.IO has no official AsyncAPI binding, so:

| Socket.IO concept      | AsyncAPI element                         |
| ---------------------- | ---------------------------------------- |
| Namespace (`/chat`)    | `channel` (`x-socketio-namespace`)       |
| Event (`message:send`) | `message` (its `name` is the wire event) |
| Client → server emit   | `operation` with `action: send`          |
| Server → client push   | `operation` with `action: receive`       |
| Ack callback           | `operation.reply` → the `Ack` message    |
| Handshake JWT          | `securitySchemes.accessToken`            |

Perspective is the **client's**: `send` = client emits, `receive` = client
receives. The transport protocol is modelled as `ws`/`wss` (the real wire
protocol is Socket.IO over that transport).

## Commands

Run from `apps/api-gateway/` (uses `pnpm dlx`, no install needed):

```bash
# Validate the spec (CI-friendly, exits non-zero on errors)
pnpm asyncapi:validate

# Open AsyncAPI Studio in the browser for live editing/preview
pnpm asyncapi:preview

# Generate static HTML docs into asyncapi/output/ (open output/index.html)
pnpm asyncapi:docs
```

The generated `asyncapi/output/` directory is git-ignored — regenerate it on
demand or publish it from CI.

## Validate from the repo root

```bash
pnpm --filter @aimess/api-gateway asyncapi:validate
```
