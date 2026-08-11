import { BASE_INTERVAL_MS, HI_BUFFER_MS, levelForSlot, slotForTime, timeForSlot } from '@/lib/ladder'
import { runBudgetGovernor, runHiDemoter, runJanitor, storeFrame } from '@/lib/storage/archive'
import type { FrameRecord } from '@/lib/storage/idb'
import type { RigSettings } from '@/lib/settings'

export interface EngineEvents {
  onFrame?: (rec: FrameRecord) => void
  onError?: (err: unknown) => void
  onMaintenance?: (info: { thinned: number; demoted: number; trimmed: number }) => void
}

const LUM_W = 24
const LUM_H = 14
/** Maintenance is cheap but pointless every tick; once a minute is plenty. */
const MAINTENANCE_EVERY_MS = 60_000

export class CaptureEngine {
  private video: HTMLVideoElement
  private settings: RigSettings
  private events: EngineEvents
  private timer: number | null = null
  private running = false
  private lastMaintenance = 0
  private busy = false

  private loCanvas = new OffscreenCanvas(1280, 720)
  private hiCanvas = new OffscreenCanvas(1920, 1080)
  private lumCanvas = new OffscreenCanvas(LUM_W, LUM_H)

  framesCaptured = 0
  lastFrameAt: number | null = null

  constructor(video: HTMLVideoElement, settings: RigSettings, events: EngineEvents = {}) {
    this.video = video
    this.settings = settings
    this.events = events
  }

  updateSettings(s: RigSettings) {
    this.settings = s
  }

  start() {
    if (this.running) return
    this.running = true
    this.scheduleNext()
  }

  stop() {
    this.running = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  get isRunning() {
    return this.running
  }

  /** Ticks land on the global 2s grid so slot indices stay canonical. */
  private scheduleNext() {
    if (!this.running) return
    const now = Date.now()
    const next = (Math.floor(now / BASE_INTERVAL_MS) + 1) * BASE_INTERVAL_MS
    this.timer = window.setTimeout(() => void this.tick(), Math.max(1, next - now))
  }

  private async tick() {
    if (!this.running) return
    // A slow capture must never queue up behind itself; skipping a slot is
    // harmless, a backlog is not.
    if (!this.busy) {
      this.busy = true
      try {
        await this.captureFrame()
      } catch (err) {
        this.events.onError?.(err)
      } finally {
        this.busy = false
      }
    }
    void this.maybeMaintain()
    this.scheduleNext()
  }

  private async captureFrame() {
    const v = this.video
    if (!v.videoWidth || v.readyState < 2) return

    const now = Date.now()
    const slot = slotForTime(now)
    const t = timeForSlot(slot)
    const level = levelForSlot(slot)

    const bitmap = await createImageBitmap(v)
    try {
      const srcW = bitmap.width
      const srcH = bitmap.height
      const aspect = srcW / srcH

      const loH = Math.min(this.settings.archiveHeight, srcH)
      const loW = Math.round((loH * aspect) / 2) * 2
      const lo = await this.encode(this.loCanvas, bitmap, loW, loH, this.settings.qualityLo)

      let hi: Blob | null = null
      if (this.settings.hiEnabled && srcH > loH) {
        hi = await this.encode(this.hiCanvas, bitmap, srcW, srcH, this.settings.qualityHi)
      }

      const lum = this.meanLuminance(bitmap)
      const rec = await storeFrame({ slot, t, level, lum, lo, hi })

      this.framesCaptured++
      this.lastFrameAt = t
      this.events.onFrame?.(rec)
    } finally {
      bitmap.close()
    }
  }

  private async encode(
    canvas: OffscreenCanvas,
    bitmap: ImageBitmap,
    w: number,
    h: number,
    quality: number,
  ) {
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { alpha: false })!
    ctx.drawImage(bitmap, 0, 0, w, h)
    return canvas.convertToBlob({ type: 'image/jpeg', quality })
  }

  /** Mean luminance drives the day/night bands under the viewer's scrubber. */
  private meanLuminance(bitmap: ImageBitmap) {
    const ctx = this.lumCanvas.getContext('2d', { alpha: false, willReadFrequently: true })!
    ctx.drawImage(bitmap, 0, 0, LUM_W, LUM_H)
    const { data } = ctx.getImageData(0, 0, LUM_W, LUM_H)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
    return Math.round(sum / (data.length / 4))
  }

  private async maybeMaintain() {
    const now = Date.now()
    if (now - this.lastMaintenance < MAINTENANCE_EVERY_MS) return
    this.lastMaintenance = now
    try {
      const thinned = await runJanitor(now)
      const demoted = this.settings.hiEnabled ? await runHiDemoter(HI_BUFFER_MS, now) : 0
      const { trimmed } = await runBudgetGovernor(this.settings.budgetBytes)
      if (thinned || demoted || trimmed) {
        this.events.onMaintenance?.({ thinned, demoted, trimmed })
      }
    } catch (err) {
      this.events.onError?.(err)
    }
  }
}
