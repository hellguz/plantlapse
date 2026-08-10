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

/** No status for this long and we stop pretending the rig is there. */
const STALE_MS = 12_000

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
}

export function useViewer(secret: string): ViewerController {
  const [connection, setConnection] = useState<ConnectionState>('searching')
  const [status, setStatus] = useState<RigStatus | null>(null)
  const [clip, setClip] = useState<LoadedClip | null>(null)
  const [loading, setLoading] = useState<ClipLoad | null>(null)
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null)

  const channelsRef = useRef<Channels | null>(null)
  const pendingHeaderRef = useRef<ClipHeader | null>(null)
  const lastSeenRef = useRef(0)
  const clipUrlRef = useRef<string | null>(null)

  useEffect(() => {
    // The component is keyed by secret upstream, so state starts fresh here
    // and nothing needs resetting on the way in.
    const ch = createRoom(secret)
    channelsRef.current = ch

    ch.room.onPeerJoin(() => {
      setConnection('connected')
      lastSeenRef.current = Date.now()
      ch.sendCommand({ type: 'requestStatus' })
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

    const watchdog = window.setInterval(() => {
      if (lastSeenRef.current && Date.now() - lastSeenRef.current > STALE_MS) {
        setConnection((c) => (c === 'connected' ? 'lost' : c))
      }
    }, 3_000)

    return () => {
      clearInterval(watchdog)
      ch.leave()
      channelsRef.current = null
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current)
      clipUrlRef.current = null
    }
  }, [secret])

  const send = useCallback((cmd: Parameters<Channels['sendCommand']>[0]) => {
    channelsRef.current?.sendCommand(cmd)
  }, [])

  const requestClip = useCallback(
    (id: WindowId, force = false) => {
      setLoading({ windowId: id, percent: 0 })
      send({ type: 'requestClip', windowId: id, force })
    },
    [send],
  )

  const setLive = useCallback(
    (on: boolean) => {
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

  return { connection, status, clip, loading, liveStream, requestClip, setLive, setTorch, setCamera }
}
