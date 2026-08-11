import { useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import {
  ChevronLeft,
  Flashlight,
  FlashlightOff,
  Play,
  QrCode,
  RefreshCcw,
  RotateCw,
  Settings2,
  Square,
  SwitchCamera,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, Chip, Row, Sheet, Stat, StatusDot, Switch } from '@/components/ui/primitives'
import { BlackScreen } from '@/components/rig/BlackScreen'
import { PairSheet } from '@/components/rig/PairSheet'
import { useRig } from '@/lib/rig/use-rig'
import { GB, updateSettings, useSettings, type ArchiveHeight } from '@/lib/settings'
import { navigate } from '@/lib/hash-route'
import { useElementSize } from '@/lib/use-element-size'
import { formatBytes, formatSpan, formatStampShort, rotatedAspect, rotatedStyle } from '@/lib/utils'
import { WINDOWS, steadyStateFrameCount } from '@/lib/ladder'
import { wipeAll } from '@/lib/storage/opfs'
import { DB_NAME } from '@/lib/storage/idb'

const ARCHIVE_HEIGHTS: ArchiveHeight[] = [540, 720, 1080]

export default function Rig() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const rig = useRig(videoRef)
  const settings = useSettings()
  const previewBox = useElementSize(previewRef)
  const [pairOpen, setPairOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showControls, setShowControls] = useState(true)

  const blackout = rig.armed && settings.blackScreen && !showControls

  // Rough steady-state size at the current archive resolution — the number that
  // actually decides whether half a year fits.
  const projected = useMemo(() => {
    const perFrame = { 540: 42_000, 720: 85_000, 1080: 175_000 }[settings.archiveHeight]
    return steadyStateFrameCount() * perFrame
  }, [settings.archiveHeight])

  const nextCamera = () => {
    if (rig.cameras.length < 2) return
    const i = rig.cameras.findIndex((c) => c.deviceId === settings.deviceId)
    rig.selectCamera(rig.cameras[(i + 1) % rig.cameras.length].deviceId)
  }

  // The black screen is an overlay, never a replacement: unmounting this tree
  // would tear down the <video> the capture engine is reading from and leave
  // the preview blank on the way back.
  return (
    <>
      {blackout && (
        <BlackScreen
          frames={rig.stats?.frames ?? 0}
          lastFrameAt={rig.stats?.newestT ?? null}
          peers={rig.peers.length}
          onWake={() => setShowControls(true)}
        />
      )}
      <div className="flex min-h-dvh flex-col bg-ink-950">
      {/* ------------------------------------------------------------ header */}
      <header className="safe-t flex items-center justify-between px-4 pb-3">
        <button
          onClick={() => navigate('/')}
          className="-ml-2 flex items-center gap-1 rounded-xl p-2 text-ink-400 hover:text-ink-100"
        >
          <ChevronLeft size={18} />
          <span className="text-sm">Back</span>
        </button>
        <div className="flex items-center gap-2 rounded-full border border-white/[0.07] bg-ink-850/60 px-3 py-1.5">
          <StatusDot tone={rig.armed ? 'live' : 'off'} />
          <span className="text-[11px] font-medium tracking-wide text-ink-300">
            {rig.armed ? 'Recording' : 'Idle'}
          </span>
          {rig.peers.length > 0 && (
            <span className="text-[11px] text-leaf-500">· {rig.peers.length} watching</span>
          )}
        </div>
        <button
          onClick={() => setSettingsOpen(true)}
          className="-mr-2 rounded-xl p-2 text-ink-400 hover:text-ink-100"
        >
          <Settings2 size={19} />
        </button>
      </header>

      {/* ----------------------------------------------------------- preview */}
      {/* The box carries the aspect ratio and the video fills it, so a quarter
          turn re-proportions the frame instead of spinning a landscape picture
          inside a portrait hole. */}
      <div
        ref={previewRef}
        className="relative mx-4 overflow-hidden rounded-app bg-black"
        style={{
          aspectRatio: rig.captureSize.width
            ? rotatedAspect(rig.captureSize.width, rig.captureSize.height, settings.rotation)
            : rotatedAspect(3, 4, settings.rotation),
        }}
      >
        {/* The preview must show exactly what gets archived, so it follows the
            camera's real aspect ratio and never crops. */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 size-full object-contain"
          style={rotatedStyle(settings.rotation, previewBox)}
        />

        {!rig.cameraReady && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-xs text-ink-500">
              {rig.error ? rig.error : 'Waking the camera…'}
            </div>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
          <div className="tnum flex items-center justify-between text-[11px] text-white/70">
            <span>
              {rig.captureSize.width}×{rig.captureSize.height}
            </span>
            <span>archive {settings.archiveHeight}p · every 2s</span>
          </div>
        </div>

        <div className="absolute right-3 top-3 flex flex-col gap-2">
          {rig.torchAvailable && (
            <Button
              size="icon"
              variant={rig.torchOn ? 'primary' : 'subtle'}
              onClick={() => void rig.toggleTorch()}
              aria-label="Toggle flashlight"
            >
              {rig.torchOn ? <Flashlight size={18} /> : <FlashlightOff size={18} />}
            </Button>
          )}
          {rig.cameras.length > 1 && (
            <Button size="icon" variant="subtle" onClick={nextCamera} aria-label="Switch camera">
              <SwitchCamera size={18} />
            </Button>
          )}
          <Button
            size="icon"
            variant="subtle"
            onClick={rig.rotate}
            aria-label={`Rotate the picture (currently ${settings.rotation}°)`}
          >
            <RotateCw size={18} />
          </Button>
        </div>
      </div>

      {/* ------------------------------------------------------------- stats */}
      <div className="grid grid-cols-3 gap-2 px-4 pt-4">
        <Stat
          label="Frames"
          value={(rig.stats?.frames ?? 0).toLocaleString()}
          sub={rig.stats?.newestT ? formatStampShort(rig.stats.newestT) : 'none yet'}
        />
        <Stat
          label="History"
          value={formatSpan(rig.stats?.horizonMs ?? 0)}
          sub={rig.stats?.oldestT ? `from ${formatStampShort(rig.stats.oldestT)}` : '—'}
        />
        <Stat
          label="Stored"
          value={formatBytes(rig.stats?.usage ?? 0)}
          sub={`of ${formatBytes(settings.budgetBytes)}`}
          tone={
            (rig.stats?.usage ?? 0) > settings.budgetBytes * 0.9 ? 'ember' : 'default'
          }
        />
      </div>

      {!rig.persisted && (
        <div className="mx-4 mt-3 rounded-2xl border border-ember-500/20 bg-ember-500/[0.06] p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs leading-snug text-ink-300">
              Archive is <span className="text-ember-500">evictable</span> — the browser is allowed
              to delete it if the phone runs low on space.
            </div>
            <Button size="sm" variant="subtle" onClick={() => void rig.requestPersist()}>
              Ask
            </Button>
          </div>
          <div className="mt-2 border-t border-white/[0.06] pt-2 text-[11px] leading-relaxed text-ink-500">
            Chrome usually only grants it to installed apps. Menu → <em>Add to Home screen</em>,
            open Plantlapse from the icon, then tap Ask.
          </div>
        </div>
      )}

      {rig.bake && (
        <div className="mx-4 mt-3 overflow-hidden rounded-2xl border border-white/[0.06] bg-ink-850/60 p-3">
          <div className="mb-2 flex items-center justify-between text-[11px] text-ink-400">
            <span>
              baking <span className="text-ink-100">{rig.bake.windowId.toUpperCase()}</span> ·{' '}
              {rig.bake.phase}
            </span>
            <span className="tnum">
              {Math.round((rig.bake.done / Math.max(1, rig.bake.total)) * 100)}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-ink-700">
            <motion.div
              className="h-full bg-leaf-500"
              animate={{ width: `${(rig.bake.done / Math.max(1, rig.bake.total)) * 100}%` }}
              transition={{ ease: 'linear', duration: 0.3 }}
            />
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------- actions */}
      <div className="mt-auto px-4 pb-6 pt-6">
        <div className="mb-3 flex gap-2">
          <Button variant="outline" size="md" className="flex-1" onClick={() => setPairOpen(true)}>
            <QrCode size={17} />
            Pair viewer
          </Button>
          {rig.armed && settings.blackScreen && (
            <Button variant="outline" size="md" onClick={() => setShowControls(false)}>
              Dim
            </Button>
          )}
        </div>

        {rig.armed ? (
          <Button variant="danger" size="lg" className="w-full" onClick={rig.disarm}>
            <Square size={17} />
            Stop recording
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!rig.cameraReady}
            // Arming does not dim. Blacking the screen the instant recording
            // starts hides the confirmation that it started at all — reach for
            // Dim when you have seen the frame counter move.
            onClick={() => void rig.arm()}
          >
            <Play size={18} />
            Start recording
          </Button>
        )}

        <p className="mt-3 text-center text-[11px] leading-relaxed text-ink-500">
          Keep this screen on and the phone plugged in — Android cuts camera access the moment the
          display locks.
        </p>
      </div>

      <PairSheet open={pairOpen} onClose={() => setPairOpen(false)} secret={settings.secret} />

      {/* ---------------------------------------------------------- settings */}
      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Rig settings">
        <div className="divide-y divide-white/[0.06]">
          <Row label="Name" hint="Shown on the viewer">
            <input
              value={settings.name}
              onChange={(e) => updateSettings({ name: e.target.value })}
              className="w-32 rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-right text-sm outline-none focus:border-leaf-500/40"
            />
          </Row>

          <Row label="Archive resolution" hint={`≈ ${formatBytes(projected)} at steady state`}>
            <div className="flex gap-1 rounded-full bg-ink-800 p-1">
              {ARCHIVE_HEIGHTS.map((h) => (
                <Chip
                  key={h}
                  active={settings.archiveHeight === h}
                  onClick={() => updateSettings({ archiveHeight: h })}
                >
                  {h}p
                </Chip>
              ))}
            </div>
          </Row>

          <Row
            label="Storage budget"
            hint={`${formatBytes(settings.budgetBytes)} — oldest history is sacrificed above this`}
          >
            <input
              type="range"
              min={1}
              max={32}
              step={1}
              value={Math.round(settings.budgetBytes / GB)}
              onChange={(e) => updateSettings({ budgetBytes: Number(e.target.value) * GB })}
              className="w-32 accent-leaf-500"
            />
          </Row>

          <Row
            label="Full-res buffer"
            hint="Recent windows bake at native resolution; older ones use the archive copy"
          >
            <Switch
              checked={settings.hiEnabled}
              onChange={(v) => updateSettings({ hiEnabled: v })}
              label="Full-res buffer"
            />
          </Row>

          <Row label="Pre-bake clips" hint="Keeps every range instant to open">
            <Switch
              checked={settings.autoBake}
              onChange={(v) => updateSettings({ autoBake: v })}
              label="Pre-bake clips"
            />
          </Row>

          <Row label="Black screen" hint="Offers the Dim button while armed — near-zero draw on AMOLED">
            <Switch
              checked={settings.blackScreen}
              onChange={(v) => updateSettings({ blackScreen: v })}
              label="Black screen"
            />
          </Row>
        </div>

        <Card className="mt-5">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">
            Rebake now
          </div>
          <div className="flex flex-wrap gap-1.5">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                onClick={() => rig.bakeNow(w.id)}
                className="rounded-full border border-white/10 px-3 py-1.5 text-[12px] font-semibold text-ink-300 hover:border-leaf-500/40 hover:text-leaf-500"
              >
                <RefreshCcw size={11} className="mr-1 inline" />
                {w.label}
              </button>
            ))}
          </div>
        </Card>

        <Button
          variant="danger"
          size="md"
          className="mt-4 w-full"
          onClick={() => {
            if (!confirm('Delete every stored frame and clip? This cannot be undone.')) return
            rig.disarm()
            void wipeAll().then(() => {
              indexedDB.deleteDatabase(DB_NAME)
              location.reload()
            })
          }}
        >
          <Trash2 size={16} />
          Erase archive
        </Button>
      </Sheet>
      </div>
    </>
  )
}
