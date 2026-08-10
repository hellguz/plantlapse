import type { WindowId } from '@/lib/ladder'

export interface BakeRequest {
  type: 'bake'
  windowId: WindowId
  spanMs: number
  level: number
  now: number
  /** Upper bound on output height; the source may be smaller. */
  maxHeight: number
}

export type BakeMessage =
  | { type: 'progress'; windowId: WindowId; done: number; total: number; phase: string }
  | {
      type: 'done'
      windowId: WindowId
      bytes: Uint8Array
      timestamps: Float64Array
      width: number
      height: number
      durationS: number
      fromT: number
      toT: number
      level: number
    }
  | { type: 'error'; windowId: WindowId; message: string }
