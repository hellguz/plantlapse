import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoom, type Channels } from '@/lib/net/room'
import type { ClipHeader, ConnectionState, RigStatus } from '@/lib/net/protocol'
import type { WindowId } from '@/lib/ladder'

interface LoadedClip {
  header: ClipHeader
  url: string
  blob: Blob
}

interface ClipLoad {
  windowId: WindowId
  percent: number
}

/** What the viewer currently wants to be watching. */
interface Intent {
  live: boolean
  windowId: WindowId | null
}

/** No status for this long and we stop pretending the rig is there. */
const STALE_MS = 12_000
/** How long to sit disconnected before tearing the room down and rejoining. */
const REJOIN_AFTER_MS = 9_000
const TICK_MS = 2_000

export interface ViewerController {
  connection: ConnectionState
  status: RigStatus | null
  clip: LoadedClip | null
  loading: ClipLoad | null
  liveStream: MediaStream | null
  requestClip: (id: WindowId, force?: boolean) => void
  setLive: (on: boolean) => void
  setTorch: (on: boolean) => void
  setCamera: (deviceId: string) => void
  reconnect: () => void
}

export function useViewer(secret: string): ViewerController {
  const [connection, setConnection] = useState<ConnectionState>('searching')
  const [status, setStatus] = useState<RigStatus | null>(null)
  const [clip, setClip] = useState<LoadedClip | null>(null)
  const [loading, setLoading] = useState<ClipLoad | null>(null)
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null)
  /** Bumping this tears down the room and joins again from scratch. */
  const [epoch, setEpoch] = useState(0)

  const channelsRef = useRef<Channels | null>(null)
  const pendingHeaderRef = useRef<ClipHeader | null>(null)
  const lastSeenRef = useRef(0)
  const clipUrlRef = useRef<string | null>(null)
  const intentRef = useRef<Intent>({ live: true, windowId: null })

  const reconnect = useCallback(() => setEpoch((e) => e + 1), [])

  useEffect(() => {
    const ch = createRoom(secret)
    channelsRef.current = ch
    const joinedAt = Date.now()

    /**
     * Anything sent before a peer exists goes nowhere — Trystero has no one to
     * deliver to and reports no error. So the viewer's intent is replayed the
     * moment a peer appears, rather than fired once at mount and hoped for.
     */
    const flushIntent = () => {
      const { live, windowId } = intentRef.current
      ch.sendCommand({ type: 'requestStatus' })
      ch.sendCommand({ type: 'setLive', on: live })
      if (windowId) ch.sendCommand({ type: 'requestClip', windowId })
    }

    ch.room.onPeerJoin(() => {
      setConnection('connected')
      lastSeenRef.current = Date.now()
      flushIntent()
    })

    ch.room.onPeerLeave(() => {
      if (!Object.keys(ch.room.getPeers()).length) {
        setConnection('lost')
        setLiveStream(null)
      }
    })

    ch.onStatus((s) => {
      lastSeenRef.current = Date.now()
      setConnection('connected')
      setStatus(s)
    })

    ch.room.onPeerStream((stream) => setLiveStream(stream))

    ch.onClipHeader((h) => {
      pendingHeaderRef.current = h
      setLoading({ windowId: h.windowId, percent: 0 })
    })

    ch.onClipProgress((pct) => {
      const h = pendingHeaderRef.current
      if (h) setLoading({ windowId: h.windowId, percent: pct })
    })

    ch.onClipData((data) => {
      const header = pendingHeaderRef.current
      if (!header) return
      pendingHeaderRef.current = null

      const blob = new Blob([data], { type: 'video/mp4' })
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current)
      const url = URL.createObjectURL(blob)
      clipUrlRef.current = url
      setClip({ header, url, blob })
      setLoading(null)
    })

    /**
     * Relay discovery is best-effort: a join announcement can be missed, and a
     * connection that survived a backgrounded tab is often already dead. Rather
     * than leave the user staring at "searching", rejoin the room outright once
     * we have been out of contact long enough.
     */
    const watchdog = window.setInterval(() => {
      const now = Date.now()
      const seen = lastSeenRef.current
      const peers = Object.keys(ch.room.getPeers()).length

      if (seen && now - seen > STALE_MS) {
        setConnection((c) => (c === 'connected' ? 'lost' : c))
      }

      const quietFor = now - (seen || joinedAt)
      if (!peers && quietFor > REJOIN_AFTER_MS) reconnect()
    }, TICK_MS)

    // Coming back to the tab is the single likeliest moment to find a dead
    // connection, so probe immediately instead of waiting for the watchdog.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (Object.keys(ch.room.getPeers()).length) {
        ch.sendCommand({ type: 'requestStatus' })
      } else {
        reconnect()
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(watchdog)
      document.removeEventListener('visibilitychange', onVisible)
      ch.leave()
      channelsRef.current = null
    }
  }, [secret, epoch, reconnect])

  // Object URLs outlive the room, so they are released with the component.
  useEffect(() => {
    return () => {
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current)
      clipUrlRef.current = null
    }
  }, [])

  const send = useCallback((cmd: Parameters<Channels['sendCommand']>[0]) => {
    channelsRef.current?.sendCommand(cmd)
  }, [])

  const requestClip = useCallback(
    (id: WindowId, force = false) => {
      intentRef.current = { live: false, windowId: id }
      setLoading({ windowId: id, percent: 0 })
      send({ type: 'requestClip', windowId: id, force })
    },
    [send],
  )

  const setLive = useCallback(
    (on: boolean) => {
      intentRef.current = { ...intentRef.current, live: on }
      if (!on) setLiveStream(null)
      send({ type: 'setLive', on })
    },
    [send],
  )

  const setTorch = useCallback((on: boolean) => send({ type: 'setTorch', on }), [send])
  const setCamera = useCallback(
    (deviceId: string) => send({ type: 'setCamera', deviceId }),
    [send],
  )

  return {
    connection,
    status,
    clip,
    loading,
    liveStream,
    requestClip,
    setLive,
    setTorch,
    setCamera,
    reconnect,
  }
}
