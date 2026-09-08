import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  createWakeLock,
  listCameras,
  openCamera,
  setTorch,
  stopStream,
  type CameraInfo,
} from '@/lib/capture/camera'
import { CaptureEngine } from '@/lib/capture/engine'
import { Baker, type BakeProgress } from '@/lib/bake/baker'
import { WINDOWS, WINDOW_BY_ID, type WindowId } from '@/lib/ladder'
import {
  archiveStats,
  getClipMeta,
  luminanceProfile,
  nearestFrame,
  type ArchiveStats,
} from '@/lib/storage/archive'
import { isPersisted, readClip, readFrame, requestPersistence } from '@/lib/storage/opfs'
import { createRoom, type Channels } from '@/lib/net/room'
import { watchRelays } from '@/lib/net/health'
import type { ClipHeader, RigStatus, ViewerCommand } from '@/lib/net/protocol'
import { getSettings, updateSettings, useSettings } from '@/lib/settings'
import { asRotation, nextRotation } from '@/lib/utils'

const STATUS_INTERVAL_MS = 2_000
const STATS_INTERVAL_MS = 5_000
const AUTOBAKE_INTERVAL_MS = 20_000
/** How often the rig checks that its own room and camera are still alive. */
const SUPERVISE_INTERVAL_MS = 15_000
/**
 * Rejoin even with healthy-looking relays after this long without a peer. A
 * relay can go quiet in ways a socket check cannot see (an announce swallowed,
 * a subscription dropped server-side), and a rejoin nobody needed costs one
 * REQ on an already-open socket.
 */
const ROOM_QUIET_REJOIN_MS = 15 * 60_000
/** Recording, but no frame has landed for this long: the camera is gone. */
const CAPTURE_STALL_MS = 60_000
/** A muted track can recover on its own; past this it will not. */
const TRACK_MUTE_GRACE_MS = 30_000
/** Wait before another getUserMedia after one failed. */
const CAMERA_RETRY_MS = 10_000

interface BatteryLike extends EventTarget {
  level: number
  charging: boolean
}

export interface RigController {
  cameras: CameraInfo[]
  torchAvailable: boolean
  torchOn: boolean
  captureSize: { width: number; height: number }
  armed: boolean
  stats: ArchiveStats | null
  persisted: boolean
  peers: string[]
  bake: BakeProgress | null
  error: string | null
  cameraReady: boolean
  arm: () => Promise<void>
  disarm: () => void
  toggleTorch: () => Promise<void>
  selectCamera: (deviceId: string) => void
  rotate: () => void
  bakeNow: (id: WindowId) => void
  requestPersist: () => Promise<void>
}

/**
 * The video element is owned by the caller rather than returned from here:
 * handing a ref back out through the controller object would make every read
 * of that object a ref access during render.
 */
export function useRig(videoRef: RefObject<HTMLVideoElement | null>): RigController {
  const settings = useSettings()

  const [cameras, setCameras] = useState<CameraInfo[]>([])
  const [torchAvailable, setTorchAvailable] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [captureSize, setCaptureSize] = useState({ width: 0, height: 0 })
  const [armed, setArmed] = useState(false)
  const [stats, setStats] = useState<ArchiveStats | null>(null)
  const [persisted, setPersisted] = useState(false)
  const [peers, setPeers] = useState<string[]>([])
  const [bake, setBake] = useState<BakeProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)
  /**
   * Bumping either of these rebuilds the thing it names, from scratch. They are
   * how the supervisors below recover a dead camera or a deaf room without the
   * page reload that used to be the only cure.
   */
  const [cameraEpoch, setCameraEpoch] = useState(0)
  const [roomEpoch, setRoomEpoch] = useState(0)

  const streamRef = useRef<MediaStream | null>(null)
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const engineRef = useRef<CaptureEngine | null>(null)
  const wakeRef = useRef(createWakeLock())
  const channelsRef = useRef<Channels | null>(null)
  const livePeersRef = useRef(new Set<string>())
  const batteryRef = useRef<BatteryLike | null>(null)
  const settingsRef = useRef(settings)
  /** Survives a camera reopen, so a night-time torch comes back with it. */
  const torchWantedRef = useRef(false)
  const mutedSinceRef = useRef<number | null>(null)
  const armedAtRef = useRef(0)

  const [baker] = useState(() => new Baker(setBake))

  // Declared first so every effect below observes the current settings.
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  /* ---------------------------------------------------------------- camera */

  const reopenCamera = useCallback(() => setCameraEpoch((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    let retry: number | null = null

    async function boot() {
      try {
        setCameraReady(false)
        stopStream(streamRef.current)
        const res = await openCamera(settingsRef.current.deviceId)
        if (cancelled) {
          stopStream(res.stream)
          return
        }
        streamRef.current = res.stream
        trackRef.current = res.track
        mutedSinceRef.current = null
        setTorchAvailable(res.torchAvailable)
        setTorchOn(false)
        setCaptureSize({ width: res.width, height: res.height })
        setStream(res.stream)
        setCameras(await listCameras())
        if (!settingsRef.current.deviceId && res.deviceId) {
          updateSettings({ deviceId: res.deviceId })
        }
        // A reopen in the small hours must come back with the light it had.
        if (torchWantedRef.current && res.torchAvailable) {
          if (await setTorch(res.track, true)) setTorchOn(true)
        }
        setCameraReady(true)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Camera unavailable')
        // Another app holding the camera, or a device that vanished mid-switch,
        // is usually temporary — and giving up on it silently is the failure
        // this rig cannot have. Keep asking.
        if (!cancelled) retry = window.setTimeout(reopenCamera, CAMERA_RETRY_MS)
      }
    }

    void boot()
    return () => {
      cancelled = true
      if (retry !== null) clearTimeout(retry)
    }
  }, [settings.deviceId, cameraEpoch, reopenCamera, videoRef])

  /**
   * Camera supervisor.
   *
   * Android takes the camera away for reasons the page never hears about: a
   * dialer notification, a doze cycle, another app grabbing the sensor. The
   * track ends or mutes, `captureFrame` quietly finds nothing to read, and the
   * rig goes on reporting itself as recording — no error, no frames, a black
   * live view. Nothing in the page ever asked for the camera again, which is
   * why the fix used to be a reload.
   */
  useEffect(() => {
    if (!cameraReady) return
    const id = window.setInterval(() => {
      const track = trackRef.current
      const now = Date.now()

      if (!track || track.readyState === 'ended') {
        reopenCamera()
        return
      }

      // A muted track is often momentary (a focus hunt, a rotation), so it gets
      // a grace period rather than an immediate reopen.
      if (track.muted) {
        mutedSinceRef.current ??= now
        if (now - mutedSinceRef.current > TRACK_MUTE_GRACE_MS) {
          mutedSinceRef.current = null
          reopenCamera()
          return
        }
      } else {
        mutedSinceRef.current = null
      }

      // The element can end up paused after a background/foreground cycle, and
      // a paused element hands `createImageBitmap` the same frame forever.
      const el = videoRef.current
      if (el && stream) {
        if (el.srcObject !== stream) el.srcObject = stream
        if (el.paused) void el.play().catch(() => {})
      }

      // Last resort: recording, camera claims to be fine, no frame has landed
      // in a minute. Something upstream is wedged — take the camera again.
      const engine = engineRef.current
      if (engine?.isRunning) {
        const since = engine.lastFrameAt ?? armedAtRef.current
        if (since && now - since > CAPTURE_STALL_MS) reopenCamera()
      }
    }, SUPERVISE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [cameraReady, stream, reopenCamera, videoRef])

  /**
   * Bind the stream to whatever element is currently mounted. Doing this in
   * its own effect (rather than inline at open time) means the preview
   * survives the element being remounted — e.g. on the way back from the
   * black armed screen, which previously left it showing nothing.
   */
  useEffect(() => {
    const el = videoRef.current
    if (!el || !stream || el.srcObject === stream) return
    el.srcObject = stream
    void el.play().catch(() => {})
  })

  /**
   * A viewer can ask for live before the camera has finished opening, or while
   * a camera switch is in flight. Re-publish to everyone who asked whenever the
   * stream changes, so the request is never simply lost.
   */
  useEffect(() => {
    const ch = channelsRef.current
    if (!ch || !stream) return
    for (const peerId of livePeersRef.current) {
      void ch.room.addStream(stream, peerId)
    }
  }, [stream])

  useEffect(() => {
    const wake = wakeRef.current
    return () => {
      stopStream(streamRef.current)
      engineRef.current?.stop()
      baker.dispose()
      void wake.disable()
    }
  }, [baker])

  /* ------------------------------------------------------------- battery */

  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }
    nav.getBattery?.()
      .then((b) => {
        batteryRef.current = b
      })
      .catch(() => {})
  }, [])

  /* --------------------------------------------------------------- stats */

  useEffect(() => {
    let alive = true
    const tick = () => {
      void archiveStats().then((s) => alive && setStats(s))
      void isPersisted().then((p) => alive && setPersisted(p))
    }
    tick()
    const id = window.setInterval(tick, STATS_INTERVAL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  /* ---------------------------------------------------------------- baker */

  useEffect(() => {
    if (!armed || !settings.autoBake) return
    const id = window.setInterval(() => {
      if (baker.busy) return
      void baker.mostStale().then((stale) => {
        if (stale) void baker.bake(stale)
      })
    }, AUTOBAKE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [armed, settings.autoBake, baker])

  /* ------------------------------------------------------------------ p2p */

  const buildStatus = useCallback(async (): Promise<RigStatus> => {
    const s = settingsRef.current
    const st = await archiveStats()
    const clips: RigStatus['clips'] = {}
    for (const w of WINDOWS) {
      const meta = await getClipMeta(w.id)
      if (meta) {
        clips[w.id] = {
          bakedAt: meta.bakedAt,
          durationS: meta.durationS,
          size: meta.size,
          width: meta.width,
          height: meta.height,
          frames: meta.timestamps.length,
          fromT: meta.fromT,
          toT: meta.toT,
        }
      }
    }
    return {
      ts: Date.now(),
      name: s.name,
      armed: engineRef.current?.isRunning ?? false,
      live: livePeersRef.current.size > 0,
      torchOn,
      torchAvailable,
      cameras: cameras.map((c) => ({ deviceId: c.deviceId, label: c.label, facing: c.facing })),
      activeDeviceId: s.deviceId,
      rotation: s.rotation,
      captureWidth: captureSize.width,
      captureHeight: captureSize.height,
      archiveHeight: s.archiveHeight,
      frames: st.frames,
      usage: st.usage,
      quota: st.quota,
      budget: s.budgetBytes,
      oldestT: st.oldestT,
      newestT: st.newestT,
      persisted,
      batteryLevel: batteryRef.current?.level ?? null,
      batteryCharging: batteryRef.current?.charging ?? null,
      clips,
      baking: bake,
    }
  }, [torchOn, torchAvailable, cameras, captureSize, persisted, bake])

  // Latest-value refs so the long-lived room subscriptions never capture a
  // stale closure. Assigned in effects, never during render.
  const buildStatusRef = useRef(buildStatus)
  useEffect(() => {
    buildStatusRef.current = buildStatus
  }, [buildStatus])

  const sendClip = useCallback(
    async (peerId: string, windowId: WindowId, force: boolean) => {
      const ch = channelsRef.current
      if (!ch) return
      const meta = force ? await baker.bake(windowId) : await baker.ensureFresh(windowId)
      if (!meta) return

      const blob = await readClip(windowId)
      if (!blob) return

      const win = WINDOW_BY_ID[windowId]
      const lum = await luminanceProfile(meta.fromT, meta.toT, 240)

      const header: ClipHeader = {
        windowId,
        size: blob.size,
        durationS: meta.durationS,
        width: meta.width,
        height: meta.height,
        timestamps: Array.from(meta.timestamps),
        luminance: Array.from(lum),
        fromT: meta.fromT,
        toT: meta.toT,
        level: win.level,
        bakedAt: meta.bakedAt,
      }
      ch.sendClipHeader(header, peerId)
      await ch.sendClipData(await blob.arrayBuffer(), peerId)
    },
    [baker],
  )

  const handleCommand = useCallback(
    async (cmd: ViewerCommand, peerId: string) => {
      const ch = channelsRef.current
      if (!ch) return

      switch (cmd.type) {
        case 'setTorch': {
          if (trackRef.current) {
            const ok = await setTorch(trackRef.current, cmd.on)
            if (ok) {
              torchWantedRef.current = cmd.on
              setTorchOn(cmd.on)
            }
          }
          break
        }
        case 'setRotation': {
          // Display only — no track is reopened and no stored byte changes, so
          // this is the one piece of the camera a remote peer may touch.
          updateSettings({ rotation: asRotation(cmd.deg) })
          break
        }
        case 'setLive': {
          if (cmd.on) {
            livePeersRef.current.add(peerId)
            if (streamRef.current) void ch.room.addStream(streamRef.current, peerId)
          } else {
            livePeersRef.current.delete(peerId)
            if (streamRef.current) ch.room.removeStream(streamRef.current, peerId)
          }
          break
        }
        case 'requestClip': {
          await sendClip(peerId, cmd.windowId, cmd.force ?? false)
          break
        }
        case 'requestStatus': {
          ch.sendStatus(await buildStatusRef.current(), peerId)
          break
        }
      }
    },
    [sendClip],
  )

  const handleCommandRef = useRef(handleCommand)
  useEffect(() => {
    handleCommandRef.current = handleCommand
  }, [handleCommand])

  const rejoin = useCallback(() => setRoomEpoch((n) => n + 1), [])

  useEffect(() => {
    const ch = createRoom(settings.secret)
    channelsRef.current = ch
    const relays = watchRelays()
    const joinedAt = Date.now()
    let lastPeerAt = 0

    // Peer ids do not survive a rejoin, so the previous room's live watchers
    // must not either — otherwise `addStream` fires at ids nobody answers to.
    const livePeers = livePeersRef.current
    livePeers.clear()

    ch.room.onPeerJoin((id) => {
      lastPeerAt = Date.now()
      setPeers((p) => [...new Set([...p, id])])
      void buildStatusRef.current().then((s) => ch.sendStatus(s, id))
    })
    ch.room.onPeerLeave((id) => {
      livePeersRef.current.delete(id)
      setPeers((p) => p.filter((x) => x !== id))
    })
    ch.onCommand((cmd, peerId) => void handleCommandRef.current(cmd, peerId))

    /**
     * Scrub traffic. Deliberately kept off the command path: these are answered
     * straight from storage with no encode, no bake and no state, so a viewer
     * dragging at 20 requests a second never queues behind a clip transfer.
     */
    ch.onFrameRequest((req, peerId) => {
      void (async () => {
        const rec = await nearestFrame(req.t, req.level)
        const blob = rec ? await readFrame(rec.slot, 'lo') : null
        if (channelsRef.current !== ch) return
        // Always answer, even with nothing to send: the viewer keeps only one
        // request in flight, so a silent drop wedges its pump until the
        // timeout. `t: 0` is the "no frame there" signal — the byte is filler,
        // because a zero-length payload chunks into no packets at all.
        if (!rec || !blob) {
          ch.sendFrame(new ArrayBuffer(1), { seq: req.seq, t: 0 }, peerId)
          return
        }
        ch.sendFrame(await blob.arrayBuffer(), { seq: req.seq, t: rec.t }, peerId)
      })()
    })

    ch.onLumRequest((req, peerId) => {
      void (async () => {
        const values = await luminanceProfile(req.fromT, req.toT, req.buckets)
        if (channelsRef.current !== ch) return
        ch.sendLumProfile(
          { fromT: req.fromT, toT: req.toT, values: Array.from(values) },
          peerId,
        )
      })()
    })

    const id = window.setInterval(() => {
      if (!Object.keys(ch.room.getPeers()).length) return
      lastPeerAt = Date.now()
      void buildStatusRef.current().then((s) => ch.sendStatus(s))
    }, STATUS_INTERVAL_MS)

    /**
     * Room supervisor — the half of the reconnect story the rig never had.
     *
     * The viewer already rejoins when it goes quiet; the rig sat in a room
     * whose relay subscriptions had expired underneath it and waited for a
     * knock it could no longer hear. Days of "still recording, unreachable"
     * ended in a manual reload. Rejoining costs a REQ on sockets that are
     * already open, so it is cheap enough to do on suspicion.
     */
    const supervisor = window.setInterval(() => {
      if (channelsRef.current !== ch) return
      const peers = Object.keys(ch.room.getPeers()).length
      if (peers) return
      const quietFor = Date.now() - (lastPeerAt || joinedAt)
      if (relays.stale() || quietFor > ROOM_QUIET_REJOIN_MS) rejoin()
    }, SUPERVISE_INTERVAL_MS)

    // Two moments worth not waiting for the interval on: the network coming
    // back, and the tab being looked at again.
    const onWake = () => {
      if (channelsRef.current !== ch) return
      if (!Object.keys(ch.room.getPeers()).length) rejoin()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') onWake()
    }
    window.addEventListener('online', onWake)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(id)
      clearInterval(supervisor)
      window.removeEventListener('online', onWake)
      document.removeEventListener('visibilitychange', onVisible)
      ch.leave()
      channelsRef.current = null
      // Watchers belong to the room that is going away; leaving them on screen
      // would have the header claiming an audience across a rejoin.
      livePeers.clear()
      setPeers([])
    }
  }, [settings.secret, roomEpoch, rejoin])

  /* --------------------------------------------------------------- arming */

  const arm = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    await requestPersistence()
    setPersisted(await isPersisted())

    engineRef.current ??= new CaptureEngine(video, settingsRef.current, {
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    })
    engineRef.current.updateSettings(settingsRef.current)
    engineRef.current.start()
    armedAtRef.current = Date.now()
    await wakeRef.current.enable()
    updateSettings({ capturing: true })
    setArmed(true)
  }, [videoRef])

  const disarm = useCallback(() => {
    engineRef.current?.stop()
    void wakeRef.current.disable()
    updateSettings({ capturing: false })
    setArmed(false)
  }, [])

  /**
   * Resume by itself on load.
   *
   * Android eventually reaps a tab that has held a camera for days, and the
   * README is honest that you should expect to reopen it. Requiring a tap to
   * restart turns that into a plant that recorded one night and then quietly
   * stopped — the one failure this design cannot tolerate. `getSettings()`
   * rather than the settings ref because `disarm` writes synchronously, and a
   * stale read here would immediately re-arm what the user just stopped.
   */
  useEffect(() => {
    if (!cameraReady || armed || !getSettings().capturing) return
    void arm()
  }, [cameraReady, armed, arm])

  useEffect(() => {
    engineRef.current?.updateSettings(settings)
  }, [settings])

  /* -------------------------------------------------------------- actions */

  const toggleTorch = useCallback(async () => {
    if (!trackRef.current) return
    const next = !torchOn
    const ok = await setTorch(trackRef.current, next)
    if (ok) {
      torchWantedRef.current = next
      setTorchOn(next)
    }
  }, [torchOn])

  const selectCamera = useCallback((deviceId: string) => {
    updateSettings({ deviceId })
  }, [])

  const rotate = useCallback(() => {
    updateSettings({ rotation: nextRotation(settingsRef.current.rotation) })
  }, [])

  const bakeNow = useCallback((id: WindowId) => void baker.bake(id), [baker])

  const requestPersist = useCallback(async () => {
    await requestPersistence()
    setPersisted(await isPersisted())
  }, [])

  return {
    cameras,
    torchAvailable,
    torchOn,
    captureSize,
    armed,
    stats,
    persisted,
    peers,
    bake,
    error,
    cameraReady,
    arm,
    disarm,
    toggleTorch,
    selectCamera,
    rotate,
    bakeNow,
    requestPersist,
  }
}
