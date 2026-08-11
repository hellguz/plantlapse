import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronLeft, Radio, SlidersHorizontal } from 'lucide-react'
import { Chip, StatusDot } from '@/components/ui/primitives'
import { Timeline } from '@/components/viewer/Timeline'
import { TransportBar } from '@/components/viewer/TransportBar'
import { CameraSheet } from '@/components/viewer/CameraSheet'
import { useViewer } from '@/lib/viewer/use-viewer'
import { SeekPump } from '@/lib/viewer/seek-pump'
import type { FramePreview } from '@/lib/viewer/frame-scrubber'
import { TARGET_FPS, WINDOWS, WINDOW_BY_ID, type WindowId } from '@/lib/ladder'
import { navigate } from '@/lib/hash-route'
import { useElementSize } from '@/lib/use-element-size'
import { asRotation, clamp, cn, formatSpan, formatStamp, rotatedStyle } from '@/lib/utils'

/** Buckets in the day/night strip; matches the profile the rig returns. */
const LUM_BUCKETS = 240

interface StageGesture {
  down: boolean
  startX: number
  /** Clip seconds in 'clip' mode, wall-clock ms in 'frames' mode. */
  startT: number
  moved: boolean
  lastTap: number
  mode: 'clip' | 'frames'
  /** Range frozen at drag start, so the origin cannot slide mid-gesture. */
  fromT: number
  toT: number
}

export default function Viewer({ secret }: { secret: string }) {
  const v = useViewer(secret)
  const { requestFrame, clearPreview, requestLuminance } = v

  const [windowId, setWindowId] = useState<WindowId>('1d')
  // Live is the default: opening the app should answer "what does it look like
  // right now" without a tap.
  const [live, setLive] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [controls, setControls] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  /**
   * Wall-clock instant being previewed out of the archive, or null for "the
   * present". While live this is a peek and nothing more — the camera keeps
   * publishing throughout, and letting go of the drag drops straight back to
   * it.
   */
  const [rewindT, setRewindT] = useState<number | null>(null)

  const clipVideo = useRef<HTMLVideoElement>(null)
  const liveVideo = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<StageGesture>({
    down: false,
    startX: 0,
    startT: 0,
    moved: false,
    lastTap: 0,
    mode: 'clip',
    fromT: 0,
    toT: 0,
  })

  const [pump] = useState(() => new SeekPump())
  const stage = useElementSize(stageRef)

  // Fallback bounds for the timeline before any status has arrived.
  const [mountedAt] = useState(() => Date.now())

  const header = v.clip?.header
  const duration = header?.durationS ?? 0
  const win = WINDOW_BY_ID[windowId]

  /** Is the clip we hold the one the chips say we are watching? */
  const clipReady = !live && !!header && header.windowId === windowId && duration > 0

  /**
   * The rig's newest frame is a truer "now" than the wall clock: it is the
   * edge the archive actually reaches, so the strip never offers footage that
   * does not exist.
   */
  const scrubToT = v.status?.newestT ?? mountedAt
  const scrubFromT = Math.max(scrubToT - win.spanMs, v.status?.oldestT ?? scrubToT - win.spanMs)
  const scrubSpan = Math.max(0, scrubToT - scrubFromT)

  /**
   * Single-frame scrubbing exists for one job: peeking back out of the live
   * view without dropping it. A range whose clip is still baking gets the
   * progress bar, not a stand-in picture.
   */
  const canRewind = live && !!v.status?.newestT && scrubSpan > 0

  /**
   * A stale rewind position must not outlive the live view it belongs to, so
   * the state is filtered rather than reset — resetting would mean a setState
   * in an effect and a second render for something that is purely derived.
   */
  const activeRewindT = live ? rewindT : null

  // Read inside intervals, which would otherwise close over the status as it
  // stood when they were armed.
  const statusRef = useRef(v.status)
  useEffect(() => {
    statusRef.current = v.status
  })

  /* ------------------------------------------------------------- fetching */

  // The hook records this intent and replays it whenever a peer appears, so
  // these only need to fire when the user's choice actually changes.
  useEffect(() => {
    if (live) {
      v.setLive(true)
    } else {
      // Stop the rig publishing before asking for a clip, or it keeps an
      // unwatched camera track on the wire.
      v.setLive(false)
      v.requestClip(windowId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId, live])

  useEffect(() => {
    const el = liveVideo.current
    if (el && v.liveStream) {
      el.srcObject = v.liveStream
      void el.play().catch(() => {})
    }
  }, [v.liveStream])

  /**
   * The day/night strip normally rides along with a clip header. Live has no
   * header, so ask for the profile on its own — it is a few hundred bytes and
   * it is the whole reason the rewind is navigable.
   */
  useEffect(() => {
    if (!live || v.connection !== 'connected') return
    const ask = () => {
      const st = statusRef.current
      const to = st?.newestT ?? Date.now()
      const from = Math.max(to - win.spanMs, st?.oldestT ?? to - win.spanMs)
      requestLuminance(from, to, LUM_BUCKETS)
    }
    ask()
    // Refetch once the newest bucket could plausibly have changed. Building
    // the profile means a range scan of the archive, and six months of it does
    // not repaint every thirty seconds.
    const every = clamp(win.spanMs / LUM_BUCKETS, 30_000, 600_000)
    const id = window.setInterval(ask, every)
    return () => clearInterval(id)
  }, [live, v.connection, win.spanMs, requestLuminance])

  /* ------------------------------------------------------------- playback */

  useEffect(() => {
    pump.attach(clipVideo.current)
    return () => pump.attach(null)
  }, [pump])

  useEffect(() => {
    const el = clipVideo.current
    if (!el || !v.clip) return
    pump.reset()
    el.src = v.clip.url
    el.currentTime = 0
    setTime(0)
    void el.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    )
  }, [v.clip, pump])

  // A rAF loop rather than `timeupdate`: the latter fires ~4x/s and makes the
  // playhead visibly stutter against 60fps footage.
  useEffect(() => {
    if (!playing || !clipReady) return
    let raf = 0
    const loop = () => {
      const el = clipVideo.current
      if (el) setTime(el.currentTime)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, clipReady])

  /**
   * The controls never leave on their own. A timer that hides the range you
   * are reading, mid-read, is chrome deciding it knows better; the only thing
   * that dismisses them is a deliberate tap on the picture.
   */
  const showControls = useCallback(() => setControls(true), [])

  /* -------------------------------------------------------------- seeking */

  const seek = useCallback(
    (seconds: number) => {
      if (!duration) return
      const t = clamp(seconds, 0, duration - 0.05)
      // The readout and playhead follow the finger at 60fps whatever the
      // decoder manages; the pump catches the picture up as fast as it can.
      setTime(t)
      pump.seek(t)
    },
    [duration, pump],
  )

  /** Preview a wall-clock instant by pulling that single frame off the rig. */
  const scrubToTime = useCallback(
    (t: number) => {
      const clamped = clamp(t, scrubFromT, scrubToT)
      setRewindT(clamped)
      requestFrame(clamped, win.level)
    },
    [scrubFromT, scrubToT, win.level, requestFrame],
  )

  /** Let go and the rewind evaporates — live was never actually interrupted. */
  const endRewind = useCallback(() => {
    setRewindT(null)
    clearPreview()
  }, [clearPreview])

  const togglePlay = useCallback(() => {
    const el = clipVideo.current
    if (!el || !clipReady) return
    if (el.paused) {
      void el.play()
      setPlaying(true)
    } else {
      el.pause()
      setPlaying(false)
    }
    showControls()
  }, [clipReady, showControls])

  /* -------------------------------------------------------------- readout */

  const stampMs = useMemo(() => {
    if (!clipReady) return activeRewindT ?? v.preview?.t ?? v.status?.newestT ?? null
    if (!header?.timestamps.length) return null
    const i = clamp(Math.round(time * TARGET_FPS), 0, header.timestamps.length - 1)
    return header.timestamps[i]
  }, [clipReady, activeRewindT, v.preview, v.status, header, time])

  /**
   * Only trust a fetched profile that covers roughly the span now on screen —
   * otherwise a stale reply for the previous range paints the wrong terrain
   * under the finger for a moment after switching.
   */
  const lumValues = useMemo(() => {
    if (clipReady) return header?.luminance ?? []
    const p = v.lumProfile
    if (!live || !p) return []
    const drift = Math.abs(p.toT - p.fromT - scrubSpan)
    return drift < Math.max(win.spanMs * 0.2, 60_000) ? p.values : []
  }, [clipReady, live, header, v.lumProfile, scrubSpan, win.spanMs])

  const previewVisible = !!v.preview && activeRewindT !== null

  // The rig owns the angle so both phones agree on which way is up, and so it
  // survives reopening the viewer on a different device.
  const rotation = asRotation(v.status?.rotation)
  const turn = rotatedStyle(rotation, stage)

  /* ------------------------------------------------------------- gestures */

  const onPointerDown = (e: React.PointerEvent) => {
    const g = gesture.current
    g.mode = clipReady ? 'clip' : 'frames'
    if (g.mode === 'clip' ? !duration : !canRewind) return

    g.down = true
    g.startX = e.clientX
    g.moved = false
    if (g.mode === 'clip') {
      g.startT = clipVideo.current?.currentTime ?? 0
    } else {
      // Freeze the window for the duration of the drag. Status ticks every two
      // seconds, and a moving origin would slide the footage under the finger.
      g.fromT = scrubFromT
      g.toT = scrubToT
      g.startT = activeRewindT ?? scrubToT
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g.down) return
    const dx = e.clientX - g.startX
    if (!g.moved && Math.abs(dx) < 6) return
    if (!g.moved) {
      g.moved = true
      showControls()
      if (g.mode === 'clip') {
        clipVideo.current?.pause()
        setPlaying(false)
      }
    }
    // Full width of the surface sweeps the whole range, either way.
    const fraction = dx / window.innerWidth
    if (g.mode === 'clip') {
      seek(g.startT + fraction * duration)
    } else {
      scrubToTime(g.startT + fraction * (g.toT - g.fromT))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g.down) return
    g.down = false

    if (g.moved) {
      if (g.mode === 'frames' && live) endRewind()
      return
    }

    // Without a clip there is no ±10s to disambiguate, so a tap can act at once.
    if (g.mode === 'frames') {
      setControls((c) => {
        if (c) return false
        showControls()
        return true
      })
      return
    }

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

  const onPointerCancel = () => {
    const g = gesture.current
    if (!g.down) return
    g.down = false
    if (g.mode === 'frames' && live) endRewind()
  }

  /* ----------------------------------------------------------------- view */

  const historyMs =
    v.status?.oldestT && v.status?.newestT ? v.status.newestT - v.status.oldestT : 0
  const rewinding = live && activeRewindT !== null

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-black">
      {/* ------------------------------------------------------------ stage */}
      <div
        ref={stageRef}
        className="relative flex-1 touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <video
          ref={clipVideo}
          playsInline
          muted
          loop
          style={turn}
          className={cn(
            'absolute inset-0 size-full object-contain transition-opacity duration-300',
            clipReady ? 'opacity-100' : 'opacity-0',
          )}
          onEnded={() => setPlaying(false)}
        />
        <video
          ref={liveVideo}
          playsInline
          muted
          autoPlay
          style={turn}
          className={cn(
            'absolute inset-0 size-full object-contain transition-opacity duration-300',
            live ? 'opacity-100' : 'opacity-0',
          )}
        />

        {/* Single archive frames, painted over whatever is behind. No fade on
            the way in: it has to feel like the drag is moving the picture. */}
        <FrameSurface preview={v.preview} visible={previewVisible} style={turn} />

        <StageOverlay
          connection={v.connection}
          live={live}
          liveReady={!!v.liveStream}
          loading={v.loading}
          baking={v.status?.baking ?? null}
          hasClip={clipReady}
          previewing={previewVisible}
          windowLabel={win.label}
          onRetry={v.reconnect}
        />

        {/* No date card across the middle while dragging. Baked clips carry
            the stamp burned into the frame, live rewind is about watching the
            plant move, and the readout under the strip covers both. */}

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
            {/* Wraps rather than scrolls: a hidden horizontal scroll area
                competes with the scrub gesture and buries ranges off-screen
                on narrow phones. Every range stays reachable at any width. */}
            <div className="mb-3 flex flex-wrap items-center justify-center gap-1">
              {WINDOWS.map((w) => (
                <Chip
                  key={w.id}
                  active={!live && windowId === w.id}
                  muted={historyMs > 0 && historyMs < w.spanMs * 0.25}
                  onClick={() => {
                    setLive(false)
                    setWindowId(w.id)
                    endRewind()
                    showControls()
                  }}
                >
                  {w.label}
                </Chip>
              ))}
              <Chip
                active={live}
                className="ml-1"
                onClick={() => {
                  setLive((l) => !l)
                  endRewind()
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
              luminance={lumValues}
              progress={
                clipReady
                  ? duration
                    ? time / duration
                    : 0
                  : scrubSpan
                    ? ((activeRewindT ?? scrubToT) - scrubFromT) / scrubSpan
                    : 1
              }
              fromT={header && clipReady ? header.fromT : scrubFromT}
              toT={header && clipReady ? header.toT : scrubToT}
              disabled={clipReady ? !duration : !canRewind}
              onScrub={(p) => {
                if (clipReady) {
                  seek(p * duration)
                  clipVideo.current?.pause()
                  setPlaying(false)
                } else {
                  scrubToTime(scrubFromT + p * scrubSpan)
                }
                showControls()
              }}
              onScrubEnd={() => {
                if (!clipReady && live) endRewind()
              }}
            />

            {/* The timestamp is the readout that matters — where you are in
                six months of plant — so it gets the accent, not the chrome. */}
            <div className="tnum mt-2 mb-1 flex items-center justify-between gap-2 text-[11px]">
              <span className="text-[12px] font-semibold text-leaf-500">
                {stampMs ? formatStamp(stampMs) : '—'}
              </span>
              <span className="text-ink-500">
                {rewinding
                  ? `${formatSpan(scrubToT - (activeRewindT ?? scrubToT))} back`
                  : live
                    ? 'realtime'
                    : clipReady && header
                      ? `${formatSpan(header.toT - header.fromT)} in ${Math.round(header.durationS)}s`
                      : ''}
              </span>
            </div>

            <div className="pb-2">
              <TransportBar
                playing={playing}
                disabled={!clipReady}
                onToggle={togglePlay}
                onSkip={(d) => {
                  seek((clipVideo.current?.currentTime ?? 0) + d)
                  showControls()
                }}
                currentTime={time}
                duration={duration}
                downloadUrl={clipReady ? v.clip?.url : undefined}
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
        onRotate={v.setRotation}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Canvas rather than <img>: the bitmap is already decoded when it arrives, so
 * drawing it is synchronous and the stage never flashes empty between frames.
 * The layout effect matters — it runs before the scrubber's rAF releases the
 * previous bitmap.
 */
function FrameSurface({
  preview,
  visible,
  style,
}: {
  preview: FramePreview | null
  visible: boolean
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const canvas = ref.current
    if (!canvas || !preview) return
    const { bitmap } = preview
    try {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
      }
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    } catch {
      // Closed by a newer frame that won the race; that one is already drawn.
    }
  }, [preview])

  return (
    <canvas
      ref={ref}
      style={style}
      className={cn(
        'pointer-events-none absolute inset-0 size-full object-contain',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    />
  )
}

function StageOverlay({
  connection,
  live,
  liveReady,
  loading,
  baking,
  hasClip,
  previewing,
  windowLabel,
  onRetry,
}: {
  connection: string
  live: boolean
  liveReady: boolean
  loading: { windowId: string; percent: number } | null
  baking: { windowId: string; done: number; total: number; phase: string } | null
  hasClip: boolean
  previewing: boolean
  windowLabel: string
  onRetry: () => void
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
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="relative mb-4 h-1 w-40 overflow-hidden rounded-full bg-white/10 animate-sweep" />
        <div className="text-sm text-ember-500">Reconnecting…</div>
        <div className="mt-1 max-w-64 text-center text-xs leading-relaxed text-white/35">
          The rig went quiet. Retrying automatically — if it persists, its screen may have locked.
        </div>
        <button
          onClick={onRetry}
          className="mt-4 rounded-full border border-white/15 px-4 py-1.5 text-xs text-white/60 hover:text-white"
        >
          Retry now
        </button>
      </div>
    )
  }

  // Rewound frames are on the stage; nothing below is worth covering them with.
  if (previewing) return null

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
