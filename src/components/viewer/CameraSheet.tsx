import { Flashlight, Info } from 'lucide-react'
import { Row, Sheet, Switch } from '@/components/ui/primitives'
import type { RigStatus } from '@/lib/net/protocol'
import { cn, formatBytes, formatSpan } from '@/lib/utils'

export function CameraSheet({
  open,
  onClose,
  status,
  onTorch,
  onCamera,
}: {
  open: boolean
  onClose: () => void
  status: RigStatus | null
  onTorch: (on: boolean) => void
  onCamera: (deviceId: string) => void
}) {
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
          </div>

          <div className="mt-4">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">
              Camera
            </div>
            <div className="space-y-1.5">
              {status.cameras.map((c) => {
                const active = c.deviceId === status.activeDeviceId
                return (
                  <button
                    key={c.deviceId}
                    onClick={() => onCamera(c.deviceId)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition-colors',
                      active
                        ? 'border-leaf-500/40 bg-leaf-500/[0.08]'
                        : 'border-white/[0.07] hover:border-white/15',
                    )}
                  >
                    <span className="truncate text-sm">{c.label}</span>
                    <span
                      className={cn(
                        'ml-3 shrink-0 text-[10px] uppercase tracking-wider',
                        active ? 'text-leaf-500' : 'text-ink-500',
                      )}
                    >
                      {active ? 'active' : c.facing === 'unknown' ? '' : c.facing}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="mt-2 flex gap-1.5 text-[11px] leading-relaxed text-ink-500">
              <Info size={13} className="mt-px shrink-0" />
              Switching cameras restarts capture. The archive is continuous across the change.
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
