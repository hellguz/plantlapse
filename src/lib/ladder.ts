/**
 * The retention ladder.
 *
 * Every frame is captured on a 2-second grid. Its *level* is the number of
 * trailing zero bits of its grid slot index — so level>=n frames are exactly
 * the frames spaced BASE * 2^n apart, and every coarse tier is a strict subset
 * of the finer one. One stored file therefore serves every zoom level; nothing
 * is ever duplicated.
 *
 * Thinning is then a single rule: a frame survives while its age is under the
 * keep-horizon for its level. Storage stays flat forever while the visible
 * history keeps growing.
 */

export const BASE_INTERVAL_MS = 2_000
export const MAX_LEVEL = 10 // 2s * 2^10 = 2048s ≈ 34min
export const TARGET_FPS = 60

const H = 3_600_000
const D = 86_400_000

/** Age horizon per level. Monotonically increasing — that's what makes it work. */
export const KEEP_HORIZON_MS: number[] = [
  6 * H, // L0  2s
  12 * H, // L1  4s
  1 * D, // L2  8s
  2 * D, // L3  16s
  4 * D, // L4  32s
  8 * D, // L5  64s
  16 * D, // L6  128s
  32 * D, // L7  256s
  64 * D, // L8  512s
  128 * D, // L9  1024s
  Number.POSITIVE_INFINITY, // L10 2048s — kept forever
]

function intervalMsForLevel(level: number) {
  return BASE_INTERVAL_MS * 2 ** level
}

/** Snap a wall-clock instant onto the capture grid. */
export function slotForTime(ms: number) {
  return Math.round(ms / BASE_INTERVAL_MS)
}

export function timeForSlot(slot: number) {
  return slot * BASE_INTERVAL_MS
}

/** Trailing-zero count of the slot index, capped at MAX_LEVEL. */
export function levelForSlot(slot: number) {
  if (slot === 0) return MAX_LEVEL
  let n = 0
  let s = slot
  while ((s & 1) === 0 && n < MAX_LEVEL) {
    s >>>= 1
    n++
  }
  return n
}

/** Coarsest level whose frames still cover a window of this span uniformly. */
function levelForSpan(spanMs: number) {
  for (let l = 0; l < KEEP_HORIZON_MS.length; l++) {
    if (KEEP_HORIZON_MS[l] >= spanMs) return l
  }
  return MAX_LEVEL
}

export type WindowId = '1h' | '3h' | '6h' | '12h' | '1d' | '1w' | '1m' | '6m'

export interface TimeWindow {
  id: WindowId
  label: string
  spanMs: number
  /** Frame spacing used when baking this window. */
  level: number
}

function mk(id: WindowId, label: string, spanMs: number): TimeWindow {
  return { id, label, spanMs, level: levelForSpan(spanMs) }
}

export const WINDOWS: TimeWindow[] = [
  mk('1h', '1H', 1 * H),
  mk('3h', '3H', 3 * H),
  mk('6h', '6H', 6 * H),
  mk('12h', '12H', 12 * H),
  mk('1d', '1D', 1 * D),
  mk('1w', '1W', 7 * D),
  mk('1m', '1M', 30 * D),
  mk('6m', '6M', 180 * D),
]

export const WINDOW_BY_ID = Object.fromEntries(WINDOWS.map((w) => [w.id, w])) as Record<
  WindowId,
  TimeWindow
>

/**
 * Rough steady-state frame count of the whole archive, used for storage
 * estimates in the UI. Each age band contributes span/interval frames.
 */
export function steadyStateFrameCount(horizonMs = 180 * D) {
  let total = 0
  let prev = 0
  for (let l = 0; l <= MAX_LEVEL; l++) {
    const end = Math.min(KEEP_HORIZON_MS[l], horizonMs)
    if (end <= prev) continue
    total += (end - prev) / intervalMsForLevel(l)
    prev = end
    if (prev >= horizonMs) break
  }
  if (prev < horizonMs) total += (horizonMs - prev) / intervalMsForLevel(MAX_LEVEL)
  return Math.round(total)
}
