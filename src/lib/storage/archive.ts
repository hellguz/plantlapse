import {
  KEEP_HORIZON_MS,
  MAX_LEVEL,
  resampleToClip,
  slotForTime,
  timeForSlot,
  type WindowId,
} from '@/lib/ladder'
import {
  deleteFrames,
  getFrame,
  getFrameRange,
  getMeta,
  getNewestFrame,
  getOldestFrame,
  putFrame,
  setMeta,
  countFrames,
  type FrameRecord,
} from './idb'
import { deleteFrame, pruneShardsBefore, storageEstimate, writeFrame } from './opfs'

/* -------------------------------------------------------------------------- */
/* Clip metadata                                                               */
/* -------------------------------------------------------------------------- */

export interface ClipMeta {
  id: WindowId
  bakedAt: number
  /** Wall-clock time of every encoded frame, in order. Drives the readout. */
  timestamps: Float64Array
  durationS: number
  width: number
  height: number
  size: number
  level: number
  fromT: number
  toT: number
}

const clipMetaKey = (id: WindowId) => `clip:${id}`

export function getClipMeta(id: WindowId) {
  return getMeta<ClipMeta>(clipMetaKey(id))
}

export function setClipMeta(meta: ClipMeta) {
  return setMeta(clipMetaKey(meta.id), meta)
}

/* -------------------------------------------------------------------------- */
/* Frame writes                                                                */
/* -------------------------------------------------------------------------- */

export interface StoredFrameInput {
  slot: number
  t: number
  level: number
  lum: number
  lo: Blob
  hi: Blob | null
}

export async function storeFrame(input: StoredFrameInput) {
  await writeFrame(input.slot, 'lo', input.lo)
  if (input.hi) await writeFrame(input.slot, 'hi', input.hi)
  const rec: FrameRecord = {
    slot: input.slot,
    t: input.t,
    level: input.level,
    lum: input.lum,
    loSize: input.lo.size,
    hiSize: input.hi?.size ?? 0,
  }
  await putFrame(rec)
  return rec
}

/* -------------------------------------------------------------------------- */
/* Janitor                                                                     */
/* -------------------------------------------------------------------------- */

const cursorKey = (level: number) => `janitor:cursor:${level}`
const HI_CURSOR = 'janitor:cursor:hi'

async function dropRecords(recs: FrameRecord[]) {
  if (!recs.length) return 0
  await Promise.all(
    recs.flatMap((r) => {
      const jobs = [deleteFrame(r.slot, 'lo')]
      if (r.hiSize > 0) jobs.push(deleteFrame(r.slot, 'hi'))
      return jobs
    }),
  )
  await deleteFrames(recs.map((r) => r.slot))
  return recs.length
}

/**
 * Thin frames that have aged past their level's horizon.
 *
 * Each level keeps its own cursor, so a run only ever touches the slots that
 * newly expired since the last pass — no full-archive scan.
 */
export async function runJanitor(now = Date.now()) {
  let removed = 0

  for (let level = 0; level < MAX_LEVEL; level++) {
    const horizon = KEEP_HORIZON_MS[level]
    if (!Number.isFinite(horizon)) continue

    const expiredBeforeSlot = slotForTime(now - horizon)
    const cursor = (await getMeta<number>(cursorKey(level))) ?? 0
    if (expiredBeforeSlot <= cursor) continue

    const batch = await getFrameRange(cursor, expiredBeforeSlot)
    const doomed = batch.filter((r) => r.level === level)
    removed += await dropRecords(doomed)
    await setMeta(cursorKey(level), expiredBeforeSlot + 1)
  }

  return removed
}

/**
 * Drop native-resolution variants once they age out of the hi-res buffer.
 * The archive-resolution copy stays, so history is never lost — only detail.
 */
export async function runHiDemoter(hiMaxAgeMs: number, now = Date.now()) {
  const expiredBeforeSlot = slotForTime(now - hiMaxAgeMs)
  const cursor = (await getMeta<number>(HI_CURSOR)) ?? 0
  if (expiredBeforeSlot <= cursor) return 0

  const batch = await getFrameRange(cursor, expiredBeforeSlot)
  const withHi = batch.filter((r) => r.hiSize > 0)
  await Promise.all(withHi.map((r) => deleteFrame(r.slot, 'hi')))
  await Promise.all(withHi.map((r) => putFrame({ ...r, hiSize: 0 })))
  await setMeta(HI_CURSOR, expiredBeforeSlot + 1)
  return withHi.length
}

/**
 * Last line of defence: if the archive exceeds its byte budget, sacrifice the
 * oldest history until it fits. This is the only mechanism that shortens the
 * visible horizon, and it reports how much it gave up.
 */
export async function runBudgetGovernor(budgetBytes: number) {
  const { usage } = await storageEstimate()
  if (usage <= budgetBytes) return { trimmed: 0, usage }

  let over = usage - budgetBytes
  let trimmed = 0
  const oldest = await getOldestFrame()
  if (!oldest) return { trimmed: 0, usage }

  let from = oldest.slot
  const CHUNK_SLOTS = 4096

  while (over > 0) {
    const batch = await getFrameRange(from, from + CHUNK_SLOTS)
    if (!batch.length) {
      from += CHUNK_SLOTS
      if (timeForSlot(from) > Date.now()) break
      continue
    }

    let cut = batch.length
    for (let i = 0; i < batch.length; i++) {
      over -= batch[i].loSize + batch[i].hiSize
      if (over <= 0) {
        cut = i + 1
        break
      }
    }
    trimmed += await dropRecords(batch.slice(0, cut))
    from += CHUNK_SLOTS
  }

  const newOldest = await getOldestFrame()
  if (newOldest) await pruneShardsBefore(newOldest.slot)

  return { trimmed, usage: (await storageEstimate()).usage }
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                       */
/* -------------------------------------------------------------------------- */

export interface ArchiveStats {
  frames: number
  usage: number
  quota: number
  oldestT: number | null
  newestT: number | null
  horizonMs: number
}

export async function archiveStats(): Promise<ArchiveStats> {
  const [frames, { usage, quota }, oldest, newest] = await Promise.all([
    countFrames(),
    storageEstimate(),
    getOldestFrame(),
    getNewestFrame(),
  ])
  return {
    frames,
    usage,
    quota,
    oldestT: oldest?.t ?? null,
    newestT: newest?.t ?? null,
    horizonMs: oldest && newest ? newest.t - oldest.t : 0,
  }
}

/**
 * Coarse luminance profile across a time span — the day/night bands under the
 * scrubber. Buckets are averaged so the strip stays cheap at any zoom.
 */
export async function luminanceProfile(fromT: number, toT: number, buckets = 240) {
  const recs = await getFrameRange(slotForTime(fromT), slotForTime(toT))
  const out = new Uint8Array(buckets)
  if (!recs.length) return out
  const span = Math.max(1, toT - fromT)
  const sums = new Float64Array(buckets)
  const counts = new Uint32Array(buckets)
  for (const r of recs) {
    const i = Math.min(buckets - 1, Math.max(0, Math.floor(((r.t - fromT) / span) * buckets)))
    sums[i] += r.lum
    counts[i]++
  }
  for (let i = 0; i < buckets; i++) {
    out[i] = counts[i] ? Math.round(sums[i] / counts[i]) : 0
  }
  return out
}

/**
 * The single frame nearest an instant, at a given ladder level's spacing.
 *
 * Snapping to the level grid before looking up is the whole point: a viewer
 * dragging across a 1D window asks for the same handful of slots over and over,
 * so its cache does the work and the rig is only touched for genuinely new
 * positions. Capture lands on the grid, so the snapped slot is usually a direct
 * hit; the range scan is the gap case (thinned levels, tab reaped, cold start).
 */
export async function nearestFrame(t: number, level = 0): Promise<FrameRecord | null> {
  const step = 2 ** Math.max(0, Math.min(MAX_LEVEL, level))
  const snapped = Math.round(slotForTime(t) / step) * step

  const exact = await getFrame(snapped)
  if (exact) return exact

  // Widen by a few of this level's steps, but never scan an unbounded span.
  const radius = Math.min(step * 4, 4096)
  const near = await getFrameRange(snapped - radius, snapped + radius)
  if (!near.length) return null

  const onGrid = near.filter((r) => r.slot % step === 0)
  const pool = onGrid.length ? onGrid : near
  return pool.reduce((best, r) =>
    Math.abs(r.slot - snapped) < Math.abs(best.slot - snapped) ? r : best,
  )
}

/**
 * The exact frames a window bakes, in order.
 *
 * The level filter gives the window's spacing; the resample caps the result at
 * one clip's worth. Both matter: reading a day at level 4 is ~2700 records,
 * cheap, but a 6M window is ~7600 and every frame past the cap is a JPEG decode
 * the clip would never show.
 */
export async function framesForWindow(spanMs: number, level: number, now = Date.now()) {
  const fromSlot = slotForTime(now - spanMs)
  const toSlot = slotForTime(now)
  const recs = await getFrameRange(fromSlot, toSlot)
  // level === trailing-zero count of slot, so this is exactly "level >= level".
  const step = 2 ** level
  return resampleToClip(recs.filter((r) => r.slot % step === 0))
}
