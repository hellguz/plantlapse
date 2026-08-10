import { WINDOWS, WINDOW_BY_ID, type WindowId } from '@/lib/ladder'
import { getClipMeta, setClipMeta, type ClipMeta } from '@/lib/storage/archive'
import { writeClip } from '@/lib/storage/opfs'
import { clamp } from '@/lib/utils'
import type { BakeMessage, BakeRequest } from './protocol'

export interface BakeProgress {
  windowId: WindowId
  done: number
  total: number
  phase: string
}

type ProgressHandler = (p: BakeProgress | null) => void

/** How stale a baked clip may get before it is worth re-encoding. */
function stalenessThreshold(spanMs: number) {
  return clamp(spanMs / 120, 60_000, 6 * 3_600_000)
}

export function webCodecsSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

export class Baker {
  private worker: Worker | null = null
  private queue: WindowId[] = []
  private active: WindowId | null = null
  private waiters = new Map<WindowId, Array<(m: ClipMeta | null) => void>>()
  private onProgress: ProgressHandler

  constructor(onProgress: ProgressHandler = () => {}) {
    this.onProgress = onProgress
  }

  private ensureWorker() {
    if (this.worker) return this.worker
    this.worker = new Worker(new URL('./baker.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<BakeMessage>) => void this.handle(e.data)
    this.worker.onerror = () => this.finish(this.active, null)
    return this.worker
  }

  private async handle(msg: BakeMessage) {
    if (msg.type === 'progress') {
      this.onProgress({
        windowId: msg.windowId,
        done: msg.done,
        total: msg.total,
        phase: msg.phase,
      })
      return
    }

    if (msg.type === 'error') {
      console.warn(`[baker] ${msg.windowId}: ${msg.message}`)
      this.finish(msg.windowId, null)
      return
    }

    await writeClip(msg.windowId, msg.bytes)
    const meta: ClipMeta = {
      id: msg.windowId,
      bakedAt: Date.now(),
      timestamps: msg.timestamps,
      durationS: msg.durationS,
      width: msg.width,
      height: msg.height,
      size: msg.bytes.byteLength,
      level: msg.level,
      fromT: msg.fromT,
      toT: msg.toT,
    }
    await setClipMeta(meta)
    this.finish(msg.windowId, meta)
  }

  private finish(id: WindowId | null, meta: ClipMeta | null) {
    if (id) {
      for (const w of this.waiters.get(id) ?? []) w(meta)
      this.waiters.delete(id)
    }
    this.active = null
    this.onProgress(null)
    this.pump()
  }

  private pump() {
    if (this.active || !this.queue.length) return
    const id = this.queue.shift()!
    this.active = id
    const win = WINDOW_BY_ID[id]
    const req: BakeRequest = {
      type: 'bake',
      windowId: id,
      spanMs: win.spanMs,
      level: win.level,
      now: Date.now(),
      maxHeight: 1080,
    }
    this.ensureWorker().postMessage(req)
  }

  /** Queue a bake (deduped) and resolve when that window's clip lands. */
  bake(id: WindowId): Promise<ClipMeta | null> {
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? []
      list.push(resolve)
      this.waiters.set(id, list)
      if (this.active !== id && !this.queue.includes(id)) {
        this.queue.push(id)
        this.pump()
      }
    })
  }

  /** Returns the cached clip immediately if fresh, otherwise bakes. */
  async ensureFresh(id: WindowId): Promise<ClipMeta | null> {
    const existing = await getClipMeta(id)
    const span = WINDOW_BY_ID[id].spanMs
    if (existing && Date.now() - existing.bakedAt < stalenessThreshold(span)) return existing
    return this.bake(id)
  }

  /** The single window most overdue for a rebake, or null if all are fresh. */
  async mostStale(): Promise<WindowId | null> {
    let worst: { id: WindowId; ratio: number } | null = null
    for (const w of WINDOWS) {
      const meta = await getClipMeta(w.id)
      const age = meta ? Date.now() - meta.bakedAt : Number.POSITIVE_INFINITY
      const ratio = age / stalenessThreshold(w.spanMs)
      if (ratio >= 1 && (!worst || ratio > worst.ratio)) worst = { id: w.id, ratio }
    }
    return worst?.id ?? null
  }

  get busy() {
    return this.active !== null
  }

  dispose() {
    this.worker?.terminate()
    this.worker = null
    this.queue = []
    this.active = null
    this.waiters.clear()
  }
}
