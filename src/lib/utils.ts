import type { CSSProperties } from 'react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}

export function formatBytes(n: number, digits = 1) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${units[i]}`
}

/** `93` -> `1:33`, `3784` -> `1:03:04` */
export function formatClock(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** Compact human duration for spans: `4h 12m`, `9d`, `38s`. */
export function formatSpan(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  if (d < 60) return `${d}d`
  return `${Math.round(d / 30)}mo`
}

/** The timestamp burned into frames and shown in the readout. */
export function formatStamp(ms: number) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`
}

/* -------------------------------------------------------------------------- */
/* Orientation                                                                 */
/* -------------------------------------------------------------------------- */

export type Rotation = 0 | 90 | 180 | 270

const ROTATIONS: Rotation[] = [0, 90, 180, 270]

export function nextRotation(r: Rotation): Rotation {
  return ROTATIONS[(ROTATIONS.indexOf(r) + 1) % ROTATIONS.length]
}

/** Anything arriving over the wire is coerced onto the four legal turns. */
export function asRotation(v: unknown): Rotation {
  return ROTATIONS.includes(v as Rotation) ? (v as Rotation) : 0
}

/**
 * Display-only rotation for a surface filling a `box`-sized parent.
 *
 * Nothing is ever re-encoded. The archive keeps whatever the sensor gave it and
 * the turn happens at paint time, which is the only reason it can apply to six
 * months of frames stored long before you noticed the phone was mounted
 * sideways — and why it costs the rig nothing to change.
 *
 * A quarter turn swaps the box, so the element is given the parent's dimensions
 * *transposed* and spun about its own centre. Getting that transpose right is
 * the whole trick: size it to the parent as-is and `object-fit` contains the
 * picture into a box of the wrong orientation, which then shrinks again when it
 * turns — a double fit that leaves margin on all four sides instead of two.
 */
export function rotatedStyle(deg: Rotation, box: { w: number; h: number }): CSSProperties {
  if (deg === 0) return {}
  if (deg === 180) return { transform: 'rotate(180deg)' }
  if (!box.w || !box.h) return {}
  return {
    width: box.h,
    height: box.w,
    left: '50%',
    top: '50%',
    right: 'auto',
    bottom: 'auto',
    transform: `translate(-50%, -50%) rotate(${deg}deg)`,
  }
}

/** Quarter turns swap a preview box's aspect ratio along with the picture. */
export function rotatedAspect(width: number, height: number, deg: Rotation) {
  const quarter = deg === 90 || deg === 270
  return quarter ? `${height} / ${width}` : `${width} / ${height}`
}

export function formatStampShort(ms: number) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
