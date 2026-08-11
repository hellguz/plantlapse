import { slotForTime } from '@/lib/ladder'
import type { FrameMeta, FrameRequest } from '@/lib/net/protocol'

/**
 * Scrubbing straight off the rig's archive, one JPEG at a time.
 *
 * The baked clip is the wrong thing to wait for at the start of a drag: it is
 * megabytes, and it ends whenever the last bake ran. Pulling single frames on
 * demand costs one datachannel round trip each — nothing to encode, nothing to
 * download first, and current to within one capture interval, which is what
 * makes rewinding out of the live view possible at all.
 *
 * Same shape as the seek pump: one request in flight, newest target queued
 * behind it, so a fast drag arrives at where the finger stopped rather than
 * grinding through everywhere it passed.
 */

export interface FramePreview {
  t: number
  bitmap: ImageBitmap
}

/** JPEGs are ~100KB, decoded bitmaps ~3.5MB. Cache the cheap representation. */
const CACHE_MAX = 320
/** Plenty for a phone stage, and a third of the pixels to decode. */
const DECODE_WIDTH = 720
/** A reply lost to a flaky link must not wedge the pump for good. */
const REQUEST_TIMEOUT_MS = 3_000

export class FrameScrubber {
  private publish: (p: FramePreview | null) => void
  private send: ((req: FrameRequest) => void) | null = null

  private cache = new Map<string, { t: number; blob: Blob }>()
  private want: { key: string; t: number; level: number } | null = null
  private inflight: { key: string; seq: number } | null = null
  private timer: number | null = null
  private seq = 0
  /** Bumped per paint so an older decode can't land on top of a newer one. */
  private paintSeq = 0
  private shown: ImageBitmap | null = null
  private disposed = false

  constructor(publish: (p: FramePreview | null) => void) {
    this.publish = publish
  }

  /**
   * The room is torn down and rejoined whenever the link goes quiet; the cache
   * is not, which is what makes a reconnect invisible to a drag in progress.
   */
  attach(send: (req: FrameRequest) => void) {
    this.send = send
    this.flush()
  }

  detach() {
    this.send = null
    this.inflight = null
    this.clearTimer()
  }

  /**
   * Snapping to the level's grid — the same grid the rig snaps to — is what
   * makes dragging back over your own path free rather than a second round of
   * requests for frames already in hand.
   */
  private keyFor(t: number, level: number) {
    const step = 2 ** level
    return `${level}:${Math.round(slotForTime(t) / step) * step}`
  }

  request(t: number, level: number) {
    if (this.disposed) return
    const key = this.keyFor(t, level)

    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      void this.paint(hit.blob, hit.t, ++this.paintSeq)
      return
    }

    this.want = { key, t, level }
    this.flush()
  }

  /** Stop previewing — the finger let go and live took the stage back. */
  clear() {
    this.want = null
    // Abandon whatever is mid-decode, or it would paint over the live feed a
    // beat after the user released.
    this.paintSeq++
    this.release()
    this.publish(null)
  }

  /** Wire to the room's frame channel. */
  receive(bytes: ArrayBuffer, meta: FrameMeta) {
    const pending = this.inflight
    if (!pending || pending.seq !== meta.seq) return
    this.clearTimer()
    this.inflight = null

    // `t: 0` means the archive had nothing near the requested instant.
    if (meta.t > 0 && bytes.byteLength > 1) {
      const blob = new Blob([bytes], { type: 'image/jpeg' })
      this.cache.set(pending.key, { t: meta.t, blob })
      if (this.cache.size > CACHE_MAX) {
        const oldest = this.cache.keys().next()
        if (!oldest.done) this.cache.delete(oldest.value)
      }
      void this.paint(blob, meta.t, ++this.paintSeq)
    }

    this.flush()
  }

  dispose() {
    this.disposed = true
    this.want = null
    this.inflight = null
    this.clearTimer()
    this.release()
    this.cache.clear()
  }

  private flush() {
    const send = this.send
    if (this.disposed || !send || this.inflight || !this.want) return
    const { key, t, level } = this.want
    this.want = null

    const seq = ++this.seq
    this.inflight = { key, seq }
    this.clearTimer()
    this.timer = window.setTimeout(() => {
      if (this.inflight?.seq !== seq) return
      this.inflight = null
      this.flush()
    }, REQUEST_TIMEOUT_MS)

    send({ seq, t, level })
  }

  private async paint(blob: Blob, t: number, seq: number) {
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(blob, {
        resizeWidth: DECODE_WIDTH,
        resizeQuality: 'medium',
      })
    } catch {
      return // corrupt or truncated frame; the next one is milliseconds away
    }

    if (this.disposed || seq !== this.paintSeq) {
      bitmap.close()
      return
    }

    const previous = this.shown
    this.shown = bitmap
    this.publish({ t, bitmap })
    // The consumer draws in a layout effect, which runs before rAF — so by the
    // time this fires the old bitmap's pixels are already on the canvas.
    if (previous) requestAnimationFrame(() => previous.close())
  }

  private release() {
    const previous = this.shown
    this.shown = null
    if (previous) requestAnimationFrame(() => previous.close())
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
