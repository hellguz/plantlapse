import { useSyncExternalStore } from 'react'

export type ArchiveHeight = 540 | 720 | 1080

export interface RigSettings {
  /** Pairing secret; also the Trystero room id. */
  secret: string
  name: string
  deviceId: string | null
  /** Archive-resolution height. Native capture res is used for the hi buffer. */
  archiveHeight: ArchiveHeight
  hiEnabled: boolean
  budgetBytes: number
  qualityLo: number
  qualityHi: number
  /** Auto-bake windows in the background so playback is instant. */
  autoBake: boolean
  blackScreen: boolean
}

const KEY = 'plantlapse:settings:v1'
const GB = 1024 ** 3

function randomSecret(len = 10) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

const DEFAULT_SETTINGS: Omit<RigSettings, 'secret'> = {
  name: 'Plant',
  deviceId: null,
  archiveHeight: 720,
  hiEnabled: true,
  budgetBytes: 6 * GB,
  qualityLo: 0.72,
  qualityHi: 0.82,
  autoBake: true,
  blackScreen: true,
}

function load(): RigSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const stored = JSON.parse(raw) as Partial<RigSettings>
      return { ...DEFAULT_SETTINGS, secret: randomSecret(), ...stored }
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_SETTINGS, secret: randomSecret() }
}

let current = load()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function getSettings() {
  return current
}

export function updateSettings(patch: Partial<RigSettings>) {
  current = { ...current, ...patch }
  localStorage.setItem(KEY, JSON.stringify(current))
  emit()
  return current
}

export function useSettings() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
}

export { GB }
