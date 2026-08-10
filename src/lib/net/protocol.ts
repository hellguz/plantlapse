import type { WindowId } from '@/lib/ladder'

export const APP_ID = 'plantlapse-v1'

/** Trystero namespaces are capped at 12 bytes — keep these short. */
export const CH = {
  status: 'stat',
  command: 'cmd',
  clipMeta: 'cmeta',
  clipData: 'cdata',
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

export type ViewerCommand =
  | { type: 'setTorch'; on: boolean }
  | { type: 'setCamera'; deviceId: string }
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
