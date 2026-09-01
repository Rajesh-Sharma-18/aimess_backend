# burst-bench

Two-account, real-backend harness for the burst-delivery work: it drives the
same Socket.IO and REST contract the web and mobile clients use, against a
running local stack, and reports per-scenario PASS/FAIL with the numbers behind
each verdict.

It exists because the interesting failures here are timing failures. A unit test
can prove the batcher coalesces; only two real sockets against a real chat
pipeline can show whether a ten-message burst still arrives in order, exactly
once, with the badge landing on the right number.

## Running

Needs the local stack up (`pnpm docker:up` + `pnpm dev`) and two accounts that
are friends with each other. Credentials come from the environment and are never
read from, or written to, a file.

```bash
BURST_BENCH_OUT=/tmp/burst A_ACC=<account> A_PW=<password> B_ACC=<account> B_PW=<password> \
  node apps/api-gateway/tools/burst-bench/setup.mjs
```

`setup.mjs` resolves the DM room, creates a group holding both accounts, and
finds a community they share, writing `fixtures.json` into `BURST_BENCH_OUT`
(default: the current directory). The other scripts read it:

| script | what it answers |
| --- | --- |
| `lat.mjs` | Latency table. Every burst is observed by TWO devices of the same user — one that opted into batching and one that did not — so the difference between them is the coalescing effect with machine noise cancelled out. `LABEL` names the output file, `REPS` sets repetitions. |
| `matrix.mjs` | Delivery, ordering, single-message latency, mixed content, replies, flush boundary, multi-device, scale, cross-room isolation. |
| `matrix2.mjs` | Unread/badge behaviour, the push-suppression hints, receipts, reconnect-mid-burst recovery, multi-device read convergence. |

Access tokens are cached in `BURST_BENCH_OUT/tok.json` between runs, because the
login endpoint is rate-limited per IP and a tight edit/measure loop will trip it.

## Reading the numbers

Latency on a developer machine running nine services under `tsx watch` swings by
several hundred milliseconds between runs, so a bare wall-clock threshold is not
evidence of anything. Every latency claim here is either a comparison against
the simultaneous non-batching control device, or a count (messages delivered,
socket frames, unread delta) that does not depend on how loaded the box is.
