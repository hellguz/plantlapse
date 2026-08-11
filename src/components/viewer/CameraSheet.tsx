import { Flashlight, Lock, RotateCw } from 'lucide-react'
import { Row, Sheet, Switch } from '@/components/ui/primitives'
import { Button } from '@/components/ui/button'
import type { RigStatus } from '@/lib/net/protocol'
import { asRotation, formatBytes, formatSpan, nextRotation, type Rotation } from '@/lib/utils'

export function CameraSheet({
  open,
  onClose,
  status,
  onTorch,
  onRotate,
}: {
  open: boolean
  onClose: () => void
  status: RigStatus | null
  onTorch: (on: boolean) => void
  onRotate: (deg: Rotation) => void
}) {
  const rotation = asRotation(status?.rotation)
  const activeCamera = status?.cameras.find((c) => c.deviceId === status.activeDeviceId)

  return (
    <Sheet open={open} onClose={onClose} title={status?.name ?? 'Camera'}>
      {!status ? (
        <div className="py-8 text-center text-sm text-ink-500">Waiting for the rig…</div>
      ) : (
        <>
          <div className="divide-y divide-white/[0.06]">
            <Row
              label={
                <span className="flex items-center gap-2">
                  <Flashlight size={15} className={status.torchOn ? 'text-ember-500' : ''} />
                  Flashlight
                </span>
              }
              hint={
                status.torchAvailable
                  ? 'Torch on the rig phone'
                  : 'This camera reports no torch (iOS never does)'
              }
            >
              <Switch
                checked={status.torchOn}
                disabled={!status.torchAvailable}
                onChange={onTorch}
                label="Flashlight"
              />
            </Row>

            <Row
              label={
                <span className="flex items-center gap-2">
                  <RotateCw size={15} />
                  Rotate
                </span>
              }
              hint="Turns the live view and every stored frame — nothing is re-encoded"
            >
              <Button
                size="sm"
                variant="subtle"
                onClick={() => onRotate(nextRotation(rotation))}
                aria-label="Rotate the picture"
              >
                <RotateCw size={14} />
                <span className="tnum">{rotation}°</span>
              </Button>
            </Row>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">
              Camera
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-white/[0.07] px-4 py-3">
              <span className="truncate text-sm">{activeCamera?.label ?? 'Camera'}</span>
              <span className="ml-3 shrink-0 text-[10px] uppercase tracking-wider text-ink-500">
                {activeCamera && activeCamera.facing !== 'unknown' ? activeCamera.facing : 'active'}
              </span>
            </div>
            {/* Which lens is open is decided at the phone holding it. A peer
                with the pairing secret can watch and can turn the picture the
                right way up; it cannot repoint the camera at something else. */}
            <p className="mt-2 flex gap-1.5 text-[11px] leading-relaxed text-ink-500">
              <Lock size={13} className="mt-px shrink-0" />
              Switching cameras is only possible on the rig phone itself.
            </p>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2 text-[11px]">
            <Fact label="Capture" value={`${status.captureWidth}×${status.captureHeight}`} />
            <Fact label="Archive" value={`${status.archiveHeight}p · 2s`} />
            <Fact label="Frames" value={status.frames.toLocaleString()} />
            <Fact
              label="History"
              value={
                status.oldestT && status.newestT
                  ? formatSpan(status.newestT - status.oldestT)
                  : '—'
              }
            />
            <Fact
              label="Stored"
              value={`${formatBytes(status.usage)} / ${formatBytes(status.budget)}`}
            />
            <Fact
              label="Battery"
              value={
                status.batteryLevel === null
                  ? '—'
                  : `${Math.round(status.batteryLevel * 100)}%${status.batteryCharging ? ' ⚡' : ''}`
              }
            />
          </div>

          {!status.persisted && (
            <p className="mt-4 rounded-2xl border border-ember-500/20 bg-ember-500/[0.06] p-3 text-[11px] leading-relaxed text-ink-300">
              The rig&apos;s storage is still evictable — open the rig phone and grant persistent
              storage, or the browser may reclaim old frames.
            </p>
          )}
        </>
      )}
    </Sheet>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-ink-850/50 px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-500">
        {label}
      </div>
      <div className="tnum mt-0.5 text-ink-200">{value}</div>
    </div>
  )
}
