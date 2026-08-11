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

/**
 * Every window bakes to the same one minute of playback, whatever span it
 * covers. This is the single most important number in the app: it is the frame
 * count the encoder has to chew through, so it sets both how long a bake takes
 * and how much history is worth keeping at each spacing. A 1D window resampled
 * to 3600 frames is a 24s step between frames — far finer than a plant moves.
 */
const CLIP_SECONDS = 60
const MAX_CLIP_FRAMES = CLIP_SECONDS * TARGET_FPS

const H = 3_600_000
const D = 86_400_000

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

/**
 * The spacing a window bakes at: the coarsest level that still yields a full
 * clip's worth of frames.
 *
 * One level coarser would leave the minute short. One level finer would only
 * cost storage and encode time — the extra frames get resampled straight back
 * out at bake time. The retention horizons below are derived from this choice,
 * so it is the only knob.
 */
function levelForSpan(spanMs: number) {
  const level = Math.floor(Math.log2(spanMs / MAX_CLIP_FRAMES / BASE_INTERVAL_MS))
  return Math.max(0, Math.min(MAX_LEVEL, level))
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
 * A bake starts whenever it starts, and reads back a full span from that
 * moment — so the oldest frames it wants are already at the horizon. Keep a
 * little past it or every clip loses its own tail.
 */
const HORIZON_SLACK = 1.2

/**
 * Age horizon per level, derived from the windows.
 *
 * A window baking at level k reads the frames spaced 2^k apart, which is
 * exactly the frames of level >= k — it never touches anything finer. So a
 * frame of level L is worth keeping only as long as the *largest* window that
 * bakes at level L or below still reaches back to it. Anything older is storage
 * no view can ever ask for.
 *
 * Monotonically increasing, which is what makes the janitor's single rule work:
 * coarser levels are read by larger windows by construction.
 */
function deriveHorizons(): number[] {
  const out = new Array<number>(MAX_LEVEL + 1).fill(0)
  for (const w of WINDOWS) {
    for (let l = w.level; l <= MAX_LEVEL; l++) {
      out[l] = Math.max(out[l], w.spanMs * HORIZON_SLACK)
    }
  }
  // The coarsest tier is the archive's memory: 2048s frames are ~7600 per half
  // year, so they are kept until the byte budget says otherwise. Cutting them
  // at 6M would make history the app can currently show unrecoverable later.
  out[MAX_LEVEL] = Number.POSITIVE_INFINITY
  return out
}

export const KEEP_HORIZON_MS: number[] = deriveHorizons()

/**
 * How long native-resolution copies are worth keeping.
 *
 * A window bakes in hi only if *every* frame it reads still has one, so the
 * smallest window is the only one that can ever qualify. A native frame is the
 * most expensive file in the archive — roughly double the archive copy — so
 * keeping any past that span is pure cost with no reader.
 */
export const HI_BUFFER_MS = WINDOWS[0].spanMs * HORIZON_SLACK

/**
 * Thin a window's candidate frames down to one clip's worth, evenly spaced.
 *
 * Deliberately not "every Nth": an integer stride can only halve or third the
 * list, so 5400 candidates would round down to 2700 and give a 45s clip out of
 * a minute's budget. Sampling by position lands on 3600 exactly, whatever the
 * input, which is why the level above is allowed to be generous.
 */
export function resampleToClip<T>(items: T[], max = MAX_CLIP_FRAMES): T[] {
  if (items.length <= max) return items
  const out = new Array<T>(max)
  const step = (items.length - 1) / (max - 1)
  for (let i = 0; i < max; i++) out[i] = items[Math.round(i * step)]
  return out
}

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
