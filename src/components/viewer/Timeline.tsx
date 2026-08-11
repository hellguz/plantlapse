import { useCallback, useEffect, useRef } from 'react'
import { clamp } from '@/lib/utils'

/**
 * The scrubber is not a grey bar.
 *
 * Every stored frame carries its mean luminance, so the strip can render the
 * archive's own day/night rhythm. You drag to "that morning" by looking at it,
 * not by reading a clock — which is the only navigation that scales to six
 * months of footage.
 */

const NIGHT: [number, number, number] = [0x0f, 0x0f, 0x17]
const TWILIGHT: [number, number, number] = [0x45, 0x39, 0x52]
const DAY: [number, number, number] = [0x9a, 0xb4, 0x9b]

function mix(a: [number, number, number], b: [number, number, number], t: number) {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(
    a[1] + (b[1] - a[1]) * t,
  )},${Math.round(a[2] + (b[2] - a[2]) * t)})`
}

function bandColor(lum: number) {
  const v = clamp(lum / 255, 0, 1)
  // Perceptual-ish easing: the interesting transition is in the low mids.
  const e = Math.pow(v, 0.7)
  return e < 0.5 ? mix(NIGHT, TWILIGHT, e / 0.5) : mix(TWILIGHT, DAY, (e - 0.5) / 0.5)
}

export function Timeline({
  luminance,
  progress,
  fromT,
  toT,
  onScrub,
  onScrubEnd,
  disabled,
}: {
  luminance: number[]
  progress: number
  fromT: number
  toT: number
  onScrub: (p: number) => void
  onScrubEnd?: () => void
  disabled?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const lastDayRef = useRef<number>(-1)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = wrap.clientWidth
    const h = wrap.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const n = luminance.length
    if (!n) {
      ctx.fillStyle = '#17171b'
      ctx.fillRect(0, 0, w, h)
      return
    }

    const bw = w / n
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = luminance[i] === 0 ? '#141418' : bandColor(luminance[i])
      // +1 avoids hairline seams between adjacent bars.
      ctx.fillRect(i * bw, 0, bw + 1, h)
    }

    // Midnight ticks — only when they are sparse enough to read.
    const span = toT - fromT
    const days = span / 86_400_000
    if (days > 1.2 && days < 90) {
      ctx.fillStyle = 'rgba(255,255,255,0.16)'
      const first = new Date(fromT)
      first.setHours(24, 0, 0, 0)
      for (let t = first.getTime(); t < toT; t += 86_400_000) {
        const x = ((t - fromT) / span) * w
        ctx.fillRect(x, 0, 1, h)
      }
    }
  }, [luminance, fromT, toT])

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(draw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [draw])

  const posFromEvent = (clientX: number) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    return clamp((clientX - rect.left) / rect.width, 0, 1)
  }

  const handleMove = (clientX: number) => {
    const p = posFromEvent(clientX)
    onScrub(p)
    // A tick at every midnight makes long drags feel like they have terrain.
    const day = Math.floor((fromT + p * (toT - fromT)) / 86_400_000)
    if (day !== lastDayRef.current) {
      lastDayRef.current = day
      navigator.vibrate?.(4)
    }
  }

  return (
    <div
      ref={wrapRef}
      className="relative h-11 w-full cursor-pointer touch-none overflow-hidden rounded-xl"
      onPointerDown={(e) => {
        if (disabled) return
        e.currentTarget.setPointerCapture(e.pointerId)
        handleMove(e.clientX)
      }}
      onPointerMove={(e) => {
        if (disabled || !e.currentTarget.hasPointerCapture(e.pointerId)) return
        handleMove(e.clientX)
      }}
      onPointerUp={(e) => {
        // The strip enables and disables as the source changes, so a release
        // can arrive for a press that was never captured.
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        e.currentTarget.releasePointerCapture(e.pointerId)
        onScrubEnd?.()
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />

      {/* Untraversed remainder reads as "not yet". */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0 bg-ink-950/45"
        style={{ left: `${clamp(progress, 0, 1) * 100}%` }}
      />

      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-leaf-500 shadow-[0_0_12px_rgba(74,222,128,0.7)]"
        style={{ left: `${clamp(progress, 0, 1) * 100}%` }}
      >
        <div className="absolute -top-0.5 left-1/2 size-2 -translate-x-1/2 rounded-full bg-leaf-500" />
      </div>
    </div>
  )
}
