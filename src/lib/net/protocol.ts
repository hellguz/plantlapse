import type { WindowId } from '@/lib/ladder'
import type { Rotation } from '@/lib/utils'

export const APP_ID = 'plantlapse-v1'

/** Trystero namespaces are capped at 12 bytes — keep these short. */
export const CH = {
  status: 'stat',
  command: 'cmd',
  clipMeta: 'cmeta',
  clipData: 'cdata',
  frameReq: 'freq',
  frameRes: 'fres',
  lumReq: 'lreq',
  lumRes: 'lres',
} as const

interface CameraDescriptor {
  deviceId: string
  label: string
  facing: 'environment' | 'user' | 'unknown'
}

interface ClipSummary {
  bakedAt: number
  durationS: number
  size: number
  width: number
  height: number
  frames: number
  fromT: number
  toT: number
}

interface BakeStatus {
  windowId: WindowId
  done: number
  total: number
  phase: string
}

export interface RigStatus {
  ts: number
  name: string
  armed: boolean
  live: boolean
  torchOn: boolean
  torchAvailable: boolean
  cameras: CameraDescriptor[]
  activeDeviceId: string | null
  /** Quarter turn every surface should be painted through. Display only. */
  rotation: Rotation
  captureWidth: number
  captureHeight: number
  archiveHeight: number
  frames: number
  usage: number
  quota: number
  budget: number
  oldestT: number | null
  newestT: number | null
  persisted: boolean
  batteryLevel: number | null
  batteryCharging: boolean | null
  clips: Partial<Record<WindowId, ClipSummary>>
  baking: BakeStatus | null
}

/**
 * What a paired viewer is allowed to ask the rig to do.
 *
 * Deliberately short, and deliberately missing camera selection. Which sensor
 * is open is a decision made at the phone that owns the lens — a peer that has
 * the pairing secret can watch, and can turn the picture the right way up, but
 * cannot repoint the camera at something else. `setRotation` is safe to expose
 * because it changes nothing but a CSS transform.
 */
export type ViewerCommand =
  | { type: 'setTorch'; on: boolean }
  | { type: 'setRotation'; deg: number }
  | { type: 'setLive'; on: boolean }
  | { type: 'requestClip'; windowId: WindowId; force?: boolean }
  | { type: 'requestStatus' }

export interface ClipHeader {
  windowId: WindowId
  size: number
  durationS: number
  width: number
  height: number
  /** Wall-clock time of every encoded frame — drives the timestamp readout. */
  timestamps: number[]
  /** Mean-luminance buckets across the window; paints the day/night strip. */
  luminance: number[]
  fromT: number
  toT: number
  level: number
  bakedAt: number
}

export type ConnectionState = 'idle' | 'searching' | 'connected' | 'lost'

/* -------------------------------------------------------------------------- */
/* Single-frame scrubbing                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A baked clip is the right vehicle for *playback*, and the wrong one for the
 * first second of a drag: it costs megabytes before a single pixel moves, and
 * it can never show the last few minutes, because the bake that produced it ran
 * before they happened.
 *
 * So dragging pulls one archive JPEG at a time straight off the rig — ~100 KB
 * and a datachannel round trip, no encode, nothing to wait for, current to
 * within one capture interval. The clip still does what it is good at.
 */
export interface FrameRequest {
  /** Monotonic per viewer; echoed back so late replies can be discarded. */
  seq: number
  /** Wall-clock instant wanted. The rig answers with the nearest frame it has. */
  t: number
  /**
   * Coarsest acceptable spacing, as a ladder level. Snapping requests to the
   * level's grid is what makes a slow drag back over its own path free.
   */
  level: number
}

/** Rides alongside the JPEG bytes as Trystero action metadata. */
export interface FrameMeta {
  seq: number
  /** Timestamp of the frame actually sent; 0 when the archive had nothing. */
  t: number
}

export interface LumRequest {
  fromT: number
  toT: number
  buckets: number
}

/** The day/night strip for a span the viewer has no clip header for. */
export interface LumProfile {
  fromT: number
  toT: number
  values: number[]
}
