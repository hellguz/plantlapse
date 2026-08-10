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
import { archiveStats, getClipMeta, luminanceProfile, type ArchiveStats } from '@/lib/storage/archive'
import { isPersisted, readClip, requestPersistence } from '@/lib/storage/opfs'
import { createRoom, type Channels } from '@/lib/net/room'
import type { ClipHeader, RigStatus, ViewerCommand } from '@/lib/net/protocol'
import { updateSettings, useSettings } from '@/lib/settings'

const STATUS_INTERVAL_MS = 2_000
const STATS_INTERVAL_MS = 5_000
const AUTOBAKE_INTERVAL_MS = 20_000

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

  const streamRef = useRef<MediaStream | null>(null)
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const engineRef = useRef<CaptureEngine | null>(null)
  const wakeRef = useRef(createWakeLock())
  const channelsRef = useRef<Channels | null>(null)
  const livePeersRef = useRef(new Set<string>())
  const batteryRef = useRef<BatteryLike | null>(null)
  const settingsRef = useRef(settings)

  const [baker] = useState(() => new Baker(setBake))

  // Declared first so every effect below observes the current settings.
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  /* ---------------------------------------------------------------- camera */

  useEffect(() => {
    let cancelled = false

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
        setTorchAvailable(res.torchAvailable)
        setTorchOn(false)
        setCaptureSize({ width: res.width, height: res.height })
        setStream(res.stream)
        setCameras(await listCameras())
        if (!settingsRef.current.deviceId && res.deviceId) {
          updateSettings({ deviceId: res.deviceId })
        }
        setCameraReady(true)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Camera unavailable')
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [settings.deviceId, videoRef])

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
            if (ok) setTorchOn(cmd.on)
          }
          break
        }
        case 'setCamera': {
          updateSettings({ deviceId: cmd.deviceId })
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

  useEffect(() => {
    const ch = createRoom(settings.secret)
    channelsRef.current = ch

    ch.room.onPeerJoin((id) => {
      setPeers((p) => [...new Set([...p, id])])
      void buildStatusRef.current().then((s) => ch.sendStatus(s, id))
    })
    ch.room.onPeerLeave((id) => {
      livePeersRef.current.delete(id)
      setPeers((p) => p.filter((x) => x !== id))
    })
    ch.onCommand((cmd, peerId) => void handleCommandRef.current(cmd, peerId))

    const id = window.setInterval(() => {
      if (!Object.keys(ch.room.getPeers()).length) return
      void buildStatusRef.current().then((s) => ch.sendStatus(s))
    }, STATUS_INTERVAL_MS)

    return () => {
      clearInterval(id)
      ch.leave()
      channelsRef.current = null
    }
  }, [settings.secret])

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
    await wakeRef.current.enable()
    setArmed(true)
  }, [videoRef])

  const disarm = useCallback(() => {
    engineRef.current?.stop()
    void wakeRef.current.disable()
    setArmed(false)
  }, [])

  useEffect(() => {
    engineRef.current?.updateSettings(settings)
  }, [settings])

  /* -------------------------------------------------------------- actions */

  const toggleTorch = useCallback(async () => {
    if (!trackRef.current) return
    const next = !torchOn
    const ok = await setTorch(trackRef.current, next)
    if (ok) setTorchOn(next)
  }, [torchOn])

  const selectCamera = useCallback((deviceId: string) => {
    updateSettings({ deviceId })
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
    bakeNow,
    requestPersist,
  }
}
