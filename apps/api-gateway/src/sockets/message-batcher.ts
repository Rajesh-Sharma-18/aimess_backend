/**
 * Per-room micro-batching of live message delivery.
 *
 * A burst of messages into one conversation used to leave the gateway as N
 * separate socket frames, which the client applied in N separate render passes.
 * This collects the messages that arrive for the SAME channel inside a short
 * window and hands them to the caller as one batch.
 *
 * Leading edge is immediate and non-negotiable: the first message of a quiet
 * period is emitted on its own the moment it arrives, so an isolated message
 * never pays the window. Only messages that arrive while a burst is already in
 * flight are coalesced — the window can therefore add latency to a message ONLY
 * when a faster message for the same room is already on its way.
 *
 * Channels never mix: a batch for `conv:A` can only ever contain `conv:A`
 * messages, and a busy room never delays a quiet one.
 */

/** Coalescing window. Long enough to swallow human typing bursts, short enough
 *  that the tail of a burst is never perceptibly late. */
export const MESSAGE_BATCH_WINDOW_MS = Number(
  process.env.SOCKET_MESSAGE_BATCH_WINDOW_MS ?? 300
);

/** Hard cap so a pathological producer cannot build an unbounded frame. */
export const MESSAGE_BATCH_MAX = 100;

export interface MessageBatcher {
  push: (channel: string, data: unknown) => void;
  /** Emit everything buffered right now (shutdown / tests). */
  flushAll: () => void;
}

export function createMessageBatcher(opts: {
  /** Emit ONE message on its own — leading edge, or a window that held one. */
  emitOne: (channel: string, data: unknown) => void;
  /** Emit a coalesced batch (always length >= 2, in arrival order). */
  emitBatch: (channel: string, batch: unknown[]) => void;
  windowMs?: number;
}): MessageBatcher {
  const windowMs = opts.windowMs ?? MESSAGE_BATCH_WINDOW_MS;
  const buffers = new Map<string, unknown[]>();
  const timers = new Map<string, NodeJS.Timeout>();

  const flush = (channel: string): void => {
    // May be called early by the size cap, so always retire the pending timer
    // rather than leaving a stray one to fire against the next window.
    const pending = timers.get(channel);
    if (pending) clearTimeout(pending);
    timers.delete(channel);

    const buffered = buffers.get(channel) ?? [];
    buffers.delete(channel);
    if (buffered.length === 0) {
      // Quiet window — the burst is over, so the next message is leading-edge
      // immediate again.
      return;
    }
    if (buffered.length === 1) {
      opts.emitOne(channel, buffered[0]);
    } else {
      opts.emitBatch(channel, buffered);
    }
    // Still inside a burst — keep the window open for the next slice.
    timers.set(channel, setTimeout(() => flush(channel), windowMs).unref());
  };

  return {
    push: (channel, data) => {
      if (!timers.has(channel)) {
        opts.emitOne(channel, data);
        timers.set(channel, setTimeout(() => flush(channel), windowMs).unref());
        return;
      }
      const buffered = buffers.get(channel) ?? [];
      buffered.push(data);
      buffers.set(channel, buffered);
      // A producer that outruns the window must not build an unbounded frame.
      if (buffered.length >= MESSAGE_BATCH_MAX) flush(channel);
    },
    flushAll: () => {
      for (const channel of [...buffers.keys()]) flush(channel);
    },
  };
}
