import { getRelaySockets } from 'trystero/nostr'

/**
 * Why a rig that has been up for days goes quiet without erroring.
 *
 * Trystero subscribes to each Nostr relay exactly once, when the room is
 * joined: it sends a `REQ` down the open socket and never sends it again. The
 * socket itself is supervised — a relay that drops us is reconnected on a
 * backoff — but the *subscription* is not replayed onto the new socket. So the
 * rig keeps announcing into relays that are no longer listening to it, and
 * never hears the offer a viewer sends back. Nothing throws, capture carries
 * on, and the only cure is a reload — which is exactly what re-joining the
 * room does, minus the reload.
 *
 * Re-joining is cheap (the sockets are shared and long-lived; only the `REQ`
 * and the announce loop are rebuilt), but not free, so we do it when we can
 * see it is needed: a relay is stale when it is open *now* on a different
 * socket than the one we subscribed through.
 */
export interface RelayWatch {
  /** A relay came back on a new socket, so our subscription on it is gone. */
  stale: () => boolean
}

/** Snapshot the sockets a freshly joined room subscribed through. */
export function watchRelays(): RelayWatch {
  const subscribedOn = new Map<string, WebSocket>()

  const sockets = () => {
    try {
      return getRelaySockets()
    } catch {
      return {} as Record<string, WebSocket>
    }
  }

  // A relay whose socket does not exist yet is recorded the first time it
  // appears: it cannot have carried a subscription before that.
  const remember = () => {
    for (const [url, sock] of Object.entries(sockets())) {
      if (sock && !subscribedOn.has(url)) subscribedOn.set(url, sock)
    }
  }

  remember()

  return {
    stale() {
      const live = sockets()
      for (const [url, sock] of Object.entries(live)) {
        if (!sock || sock.readyState !== WebSocket.OPEN) continue
        // Open on a socket we never sent a REQ down: reconnected under us.
        if (subscribedOn.get(url) !== sock) return true
      }
      remember()
      return false
    },
  }
}
