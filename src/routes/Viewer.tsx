import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronLeft, Radio, SlidersHorizontal } from 'lucide-react'
import { Chip, StatusDot } from '@/components/ui/primitives'
import { Timeline } from '@/components/viewer/Timeline'
import { TransportBar } from '@/components/viewer/TransportBar'
import { CameraSheet } from '@/components/viewer/CameraSheet'
import { useViewer } from '@/lib/viewer/use-viewer'
import { WINDOWS, WINDOW_BY_ID, type WindowId } from '@/lib/ladder'
import { navigate } from '@/lib/hash-route'
import { clamp, cn, formatSpan, formatStamp } from '@/lib/utils'

const CONTROLS_HIDE_MS = 3800

export default function Viewer({ secret }: { secret: string }) {
  const v = useViewer(secret)
  const [windowId, setWindowId] = useState<WindowId>('1d')
  const [live, setLive] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [controls, setControls] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)

  const clipVideo = useRef<HTMLVideoElement>(null)
  const liveVideo = useRef<HTMLVideoElement>(null)
  const hideTimer = useRef<number | null>(null)
  const gesture = useRef({ down: false, startX: 0, startT: 0, moved: false, lastTap: 0 })

  // Fallback bounds for the timeline before any clip header has arrived.
  const [mountedAt] = useState(() => Date.now())

  const header = v.clip?.header
  const duration = header?.durationS ?? 0

  /* ------------------------------------------------------------- fetching */

  useEffect(() => {
    if (live) return
    v.requestClip(windowId)
    // requestClip identity is stable; re-fetch only when the range changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId, live, v.connection === 'connected'])

  useEffect(() => {
    v.setLive(live)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

  useEffect(() => {
    const el = liveVideo.current
    if (el && v.liveStream) {
      el.srcObject = v.liveStream
      void el.play().catch(() => {})
    }
  }, [v.liveStream])

  /* ------------------------------------------------------------- playback */

  useEffect(() => {
    const el = clipVideo.current
    if (!el || !v.clip) return
    el.src = v.clip.url
    el.currentTime = 0
    setTime(0)
    void el.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    )
  }, [v.clip])

  // A rAF loop rather than `timeupdate`: the latter fires ~4x/s and makes the
  // playhead visibly stutter against 60fps footage.
  useEffect(() => {
    if (!playing || live) return
    let raf = 0
    const loop = () => {
      const el = clipVideo.current
      if (el) setTime(el.currentTime)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, live])

  const showControls = useCallback(() => {
    setControls(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setControls(false), CONTROLS_HIDE_MS)
  }, [])

  // Controls start visible; this only arms the auto-hide and cleans up.
  useEffect(() => {
    const timer = window.setTimeout(() => setControls(false), CONTROLS_HIDE_MS)
    hideTimer.current = timer
    return () => {
      clearTimeout(timer)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  const seek = useCallback(
    (seconds: number) => {
      const el = clipVideo.current
      if (!el || !duration) return
      el.currentTime = clamp(seconds, 0, duration - 0.05)
      setTime(el.currentTime)
    },
    [duration],
  )

  const togglePlay = useCallback(() => {
    const el = clipVideo.current
    if (!el) return
    if (el.paused) {
      void el.play()
      setPlaying(true)
    } else {
      el.pause()
      setPlaying(false)
    }
    showControls()
  }, [showControls])

  /* -------------------------------------------------------------- readout */

  const stampMs = useMemo(() => {
    if (!header?.timestamps.length) return null
    const i = clamp(Math.round(time * 60), 0, header.timestamps.length - 1)
    return header.timestamps[i]
  }, [header, time])

  const luminance = header?.luminance ?? []

  /* ------------------------------------------------------------- gestures */

  const onPointerDown = (e: React.PointerEvent) => {
    if (live || !duration) return
    gesture.current = {
      down: true,
      startX: e.clientX,
      startT: clipVideo.current?.currentTime ?? 0,
      moved: false,
      lastTap: gesture.current.lastTap,
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g.down || live || !duration) return
    const dx = e.clientX - g.startX
    if (Math.abs(dx) < 6 && !g.moved) return
    if (!g.moved) {
      g.moved = true
      clipVideo.current?.pause()
      setPlaying(false)
      setScrubbing(true)
      showControls()
    }
    // Full width of the surface sweeps the whole clip.
    seek(g.startT + (dx / window.innerWidth) * duration)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current
    g.down = false
    setScrubbing(false)
    if (g.moved) return

    const now = Date.now()
    if (now - g.lastTap < 280) {
      // Double tap: skip in the half of the screen that was tapped.
      seek((clipVideo.current?.currentTime ?? 0) + (e.clientX < window.innerWidth / 2 ? -10 : 10))
      navigator.vibrate?.(8)
      g.lastTap = 0
      return
    }
    // Single tap toggles the controls, but only once the double-tap window
    // has closed — otherwise every skip also flashes the chrome.
    g.lastTap = now
    setTimeout(() => {
      if (gesture.current.lastTap !== now) return
      setControls((c) => {
        if (c) return false
        showControls()
        return true
      })
    }, 280)
  }

  /* ----------------------------------------------------------------- view */

  const win = WINDOW_BY_ID[windowId]
  const historyMs =
    v.status?.oldestT && v.status?.newestT ? v.status.newestT - v.status.oldestT : 0

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-black">
      {/* ------------------------------------------------------------ stage */}
      <div
        className="relative flex-1 touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          gesture.current.down = false
          setScrubbing(false)
        }}
      >
        <video
          ref={clipVideo}
          playsInline
          muted
          loop
          className={cn(
            'absolute inset-0 size-full object-contain transition-opacity duration-300',
            live ? 'opacity-0' : 'opacity-100',
          )}
          onEnded={() => setPlaying(false)}
        />
        <video
          ref={liveVideo}
          playsInline
          muted
          autoPlay
          className={cn(
            'absolute inset-0 size-full object-contain transition-opacity duration-300',
            live ? 'opacity-100' : 'opacity-0',
          )}
        />

        <StageOverlay
          connection={v.connection}
          live={live}
          liveReady={!!v.liveStream}
          loading={v.loading}
          baking={v.status?.baking ?? null}
          hasClip={!!v.clip}
          windowLabel={win.label}
        />

        {/* Scrub readout, big while dragging. */}
        <AnimatePresence>
          {scrubbing && stampMs && (
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center"
            >
              <div className="tnum inline-block rounded-2xl bg-black/60 px-5 py-3 text-xl font-semibold backdrop-blur">
                {formatStamp(stampMs)}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* --------------------------------------------------------- header */}
        <AnimatePresence>
          {controls && (
            <motion.header
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="safe-t absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 pb-8"
            >
              <button
                onClick={() => navigate('/')}
                className="rounded-xl p-2 text-white/70 hover:text-white"
              >
                <ChevronLeft size={20} />
              </button>

              <div className="flex min-w-0 items-center gap-2 rounded-full bg-black/40 px-3 py-1.5 backdrop-blur">
                <StatusDot
                  tone={
                    v.connection === 'connected' ? 'live' : v.connection === 'lost' ? 'warn' : 'off'
                  }
                />
                <span className="truncate text-[12px] font-medium text-white/90">
                  {v.status?.name ?? 'Connecting'}
                </span>
                {v.status?.batteryLevel != null && (
                  <span className="tnum text-[11px] text-white/45">
                    {Math.round(v.status.batteryLevel * 100)}%
                  </span>
                )}
              </div>

              <button
                onClick={() => setSheetOpen(true)}
                className="rounded-xl p-2 text-white/70 hover:text-white"
              >
                <SlidersHorizontal size={19} />
              </button>
            </motion.header>
          )}
        </AnimatePresence>
      </div>

      {/* -------------------------------------------------------- controls */}
      <AnimatePresence>
        {controls && (
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 42 }}
            className="glass safe-b absolute inset-x-0 bottom-0 z-20 rounded-t-[26px] px-4 pt-3"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* Ranges. LIVE sits at the right end because it *is* the right
                end of the timeline — the newest thing there is. */}
            <div className="-mx-1 mb-3 flex items-center gap-1 overflow-x-auto px-1 pb-1">
              {WINDOWS.map((w) => (
                <Chip
                  key={w.id}
                  active={!live && windowId === w.id}
                  muted={historyMs > 0 && historyMs < w.spanMs * 0.25}
                  onClick={() => {
                    setLive(false)
                    setWindowId(w.id)
                    showControls()
                  }}
                >
                  {w.label}
                </Chip>
              ))}
              <div className="mx-1 h-4 w-px shrink-0 bg-white/10" />
              <Chip
                active={live}
                onClick={() => {
                  setLive((l) => !l)
                  showControls()
                }}
              >
                <span className="flex items-center gap-1.5">
                  <Radio size={12} />
                  LIVE
                </span>
              </Chip>
            </div>

            <Timeline
              luminance={luminance}
              progress={duration ? time / duration : 0}
              fromT={header?.fromT ?? mountedAt - win.spanMs}
              toT={header?.toT ?? mountedAt}
              disabled={live || !duration}
              onScrub={(p) => {
                seek(p * duration)
                setScrubbing(true)
                clipVideo.current?.pause()
                setPlaying(false)
                showControls()
              }}
              onScrubEnd={() => setScrubbing(false)}
            />

            <div className="tnum mt-2 mb-1 flex items-center justify-between text-[11px] text-ink-400">
              <span>{stampMs ? formatStamp(stampMs) : '—'}</span>
              <span className="text-ink-500">
                {live
                  ? 'realtime'
                  : header
                    ? `${formatSpan(header.toT - header.fromT)} in ${Math.round(header.durationS)}s`
                    : ''}
              </span>
            </div>

            <div className="pb-2">
              <TransportBar
                playing={playing}
                disabled={live || !duration}
                onToggle={togglePlay}
                onSkip={(d) => {
                  seek((clipVideo.current?.currentTime ?? 0) + d)
                  showControls()
                }}
                currentTime={time}
                duration={duration}
                downloadUrl={v.clip?.url}
                downloadName={
                  header
                    ? `plantlapse-${header.windowId}-${new Date(header.toT)
                        .toISOString()
                        .slice(0, 10)}.mp4`
                    : undefined
                }
                downloadSize={header?.size}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <CameraSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        status={v.status}
        onTorch={v.setTorch}
        onCamera={v.setCamera}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function StageOverlay({
  connection,
  live,
  liveReady,
  loading,
  baking,
  hasClip,
  windowLabel,
}: {
  connection: string
  live: boolean
  liveReady: boolean
  loading: { windowId: string; percent: number } | null
  baking: { windowId: string; done: number; total: number; phase: string } | null
  hasClip: boolean
  windowLabel: string
}) {
  if (connection === 'searching') {
    return (
      <Centered>
        <div className="relative mb-4 h-1 w-40 overflow-hidden rounded-full bg-white/10 animate-sweep" />
        <div className="text-sm text-white/60">Looking for the camera…</div>
        <div className="mt-1 text-xs text-white/30">
          Both devices need the app open on the same code
        </div>
      </Centered>
    )
  }

  if (connection === 'lost') {
    return (
      <Centered>
        <div className="text-sm text-ember-500">Camera went quiet</div>
        <div className="mt-1 max-w-64 text-center text-xs leading-relaxed text-white/35">
          The rig phone may have slept, lost network, or be behind a NAT that needs a relay.
        </div>
      </Centered>
    )
  }

  if (live && !liveReady) {
    return (
      <Centered>
        <div className="text-sm text-white/60">Opening the live feed…</div>
      </Centered>
    )
  }

  if (!live && loading) {
    // Before a byte can transfer the rig may still be encoding, which is the
    // slow part. Show that progress rather than a stalled 0%.
    const encoding = loading.percent === 0 && baking
    const pct = encoding ? baking.done / Math.max(1, baking.total) : loading.percent

    return (
      <Centered>
        <div className="mb-3 text-sm text-white/70">
          {encoding
            ? `Encoding ${baking.windowId.toUpperCase()} on the rig`
            : `Fetching ${loading.windowId.toUpperCase()}`}
        </div>
        <div className="h-1 w-44 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-leaf-500 transition-[width] duration-200"
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </div>
        <div className="tnum mt-2 text-[11px] text-white/35">
          {encoding
            ? `${baking.phase} · ${baking.done.toLocaleString()} / ${baking.total.toLocaleString()} frames`
            : pct > 0
              ? `${Math.round(pct * 100)}%`
              : 'waiting for the rig…'}
        </div>
      </Centered>
    )
  }

  if (!live && !hasClip) {
    return (
      <Centered>
        <div className="text-sm text-white/50">No {windowLabel} clip yet</div>
        <div className="mt-1 text-xs text-white/30">
          The rig needs a bit more history for this range
        </div>
      </Centered>
    )
  }

  return null
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
      {children}
    </div>
  )
}
