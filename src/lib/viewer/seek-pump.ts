/**
 * One seek in flight, newest target queued behind it.
 *
 * Assigning `currentTime` while a seek is still running aborts that seek and
 * starts another. A drag fires ~60 assignments a second, and a seek into a
 * 60fps H.264 clip takes rather longer than 16ms — so every seek was being
 * cancelled by its successor and the picture only moved once the finger
 * stopped. Coalescing here means each seek gets to finish and paint, and the
 * scrub runs at whatever rate the decoder can actually sustain.
 */

/** Half a frame at 60fps: closer than this and there is nothing to seek to. */
const EPSILON = 1 / 120
/** A seek into an unbuffered or damaged region can simply never settle. */
const GUARD_MS = 600

export class SeekPump {
  private el: HTMLVideoElement | null = null
  private want: number | null = null
  private busy = false
  private guard: number | null = null

  attach(el: HTMLVideoElement | null) {
    if (this.el === el) return
    this.el?.removeEventListener('seeked', this.onSettled)
    this.el?.removeEventListener('error', this.onSettled)
    this.reset()
    this.el = el
    el?.addEventListener('seeked', this.onSettled)
    el?.addEventListener('error', this.onSettled)
  }

  /** Drop any queued target — used when the element gets a new source. */
  reset() {
    this.want = null
    this.busy = false
    this.clearGuard()
  }

  seek(seconds: number) {
    this.want = seconds
    this.flush()
  }

  private flush = () => {
    const el = this.el
    if (!el || this.busy || this.want === null) return
    const target = this.want
    this.want = null
    // Assigning the position it already holds fires no `seeked`, which would
    // strand the pump waiting for an event that is never coming.
    if (Math.abs(target - el.currentTime) < EPSILON) return

    this.busy = true
    this.clearGuard()
    this.guard = window.setTimeout(this.onSettled, GUARD_MS)
    el.currentTime = target
  }

  private onSettled = () => {
    this.clearGuard()
    this.busy = false
    this.flush()
  }

  private clearGuard() {
    if (this.guard !== null) clearTimeout(this.guard)
    this.guard = null
  }
}
