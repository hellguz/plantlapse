import { Download, Pause, Play, Redo, Undo } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatBytes, formatClock } from '@/lib/utils'

export function TransportBar({
  playing,
  onToggle,
  onSkip,
  currentTime,
  duration,
  downloadUrl,
  downloadName,
  downloadSize,
  disabled,
}: {
  playing: boolean
  onToggle: () => void
  onSkip: (delta: number) => void
  currentTime: number
  duration: number
  downloadUrl?: string
  downloadName?: string
  downloadSize?: number
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-1 sm:gap-3">
      <div className="tnum w-16 shrink-0 text-[11px] text-ink-400 sm:w-24">
        {formatClock(currentTime)}
        <span className="text-ink-600"> / {formatClock(duration)}</span>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          disabled={disabled}
          onClick={() => onSkip(-10)}
          aria-label="Back 10 seconds"
          className="relative"
        >
          <Undo size={19} />
          <span className="tnum absolute bottom-1 right-1 text-[8px] font-bold text-ink-400">
            10
          </span>
        </Button>

        <Button
          size="iconLg"
          variant="solid"
          disabled={disabled}
          onClick={onToggle}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-0.5" />}
        </Button>

        <Button
          size="icon"
          variant="ghost"
          disabled={disabled}
          onClick={() => onSkip(10)}
          aria-label="Forward 10 seconds"
          className="relative"
        >
          <Redo size={19} />
          <span className="tnum absolute bottom-1 left-1 text-[8px] font-bold text-ink-400">
            10
          </span>
        </Button>
      </div>

      <div className="flex w-16 shrink-0 justify-end sm:w-24">
        {downloadUrl ? (
          <a
            href={downloadUrl}
            download={downloadName}
            className="flex items-center gap-1.5 rounded-xl px-2 py-2 text-ink-400 transition-colors hover:text-leaf-500"
          >
            <Download size={17} />
            {downloadSize ? (
              <span className="tnum text-[10px]">{formatBytes(downloadSize, 0)}</span>
            ) : null}
          </a>
        ) : null}
      </div>
    </div>
  )
}
