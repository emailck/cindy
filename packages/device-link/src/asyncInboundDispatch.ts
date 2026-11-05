import type { DeviceLinkClient } from './client.js';
import type { Envelope } from './protocol.js';

/**
 * Transport admission ends when the host has registered the request, not when
 * asynchronous business work completes. Returning a poll's promise to onFrame
 * blocks ordered delivery and ACKs for every later request from that peer.
 * Handlers must register idempotency/admission state before their first await.
 */
export function wireAsyncInboundDispatch(
  client: Pick<DeviceLinkClient, 'onFrame'>,
  handle: (frame: Envelope) => void | Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  return client.onFrame(frame => {
    try {
      const pending = handle(frame);
      if (pending) void pending.catch(onError);
    } catch (error) { onError(error); }
  });
}
