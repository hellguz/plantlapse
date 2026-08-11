/**
 * Camera plumbing: enumeration, opening at the best available resolution,
 * and torch control.
 *
 * `torch` is a Chrome-on-Android capability. WebKit ignores the constraint
 * (webkit bug 243075), so the UI hides the control when it isn't advertised.
 */

export interface CameraInfo {
  deviceId: string
  label: string
  facing: 'environment' | 'user' | 'unknown'
}

/** Capped at Full HD on purpose — beyond it JPEG cost dwarfs the visual gain. */
const MAX_CAPTURE_WIDTH = 1920
const MAX_CAPTURE_HEIGHT = 1080

interface TorchCapableCapabilities extends MediaTrackCapabilities {
  torch?: boolean
}

function guessFacing(label: string): CameraInfo['facing'] {
  const l = label.toLowerCase()
  if (/back|rear|environment/.test(l)) return 'environment'
  if (/front|face|user|selfie/.test(l)) return 'user'
  return 'unknown'
}

export function mediaSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

/**
 * Device labels are blank until permission has been granted at least once, so
 * callers should list *after* a successful getUserMedia.
 */
export async function listCameras(): Promise<CameraInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Camera ${i + 1}`,
      facing: guessFacing(d.label),
    }))
}

export interface OpenCameraResult {
  stream: MediaStream
  track: MediaStreamVideoTrack
  width: number
  height: number
  torchAvailable: boolean
  deviceId: string
}

/**
 * Audio is never requested, and never carried.
 *
 * `audio: false` is the ask; the sweep below is the guarantee. This stream is
 * handed straight to `room.addStream`, which publishes every track on it — so
 * an audio track surviving to that point would be a live microphone in someone
 * else's house. Belt and braces is the right amount of paranoia for a device
 * left recording in a room for months.
 */
export async function openCamera(deviceId?: string | null): Promise<OpenCameraResult> {
  const video: MediaTrackConstraints = {
    width: { ideal: MAX_CAPTURE_WIDTH },
    height: { ideal: MAX_CAPTURE_HEIGHT },
    frameRate: { ideal: 30, max: 30 },
  }
  if (deviceId) video.deviceId = { exact: deviceId }
  else video.facingMode = { ideal: 'environment' }

  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
  for (const audio of stream.getAudioTracks()) {
    audio.stop()
    stream.removeTrack(audio)
  }

  const track = stream.getVideoTracks()[0]
  const settings = track.getSettings()
  const caps = (track.getCapabilities?.() ?? {}) as TorchCapableCapabilities

  return {
    stream,
    track,
    width: settings.width ?? MAX_CAPTURE_WIDTH,
    height: settings.height ?? MAX_CAPTURE_HEIGHT,
    torchAvailable: caps.torch === true,
    deviceId: settings.deviceId ?? deviceId ?? '',
  }
}

export async function setTorch(track: MediaStreamTrack, on: boolean) {
  const caps = (track.getCapabilities?.() ?? {}) as TorchCapableCapabilities
  if (caps.torch !== true) return false
  try {
    await track.applyConstraints({
      advanced: [{ torch: on } as MediaTrackConstraintSet],
    })
    return true
  } catch {
    return false
  }
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
}

/* -------------------------------------------------------------------------- */
/* Screen wake lock                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Chrome for Android tears down getUserMedia the moment the screen locks, so
 * the wake lock is not a nicety — it is the only thing keeping capture alive.
 * It is also released automatically on tab switch, hence the re-acquire on
 * visibility change.
 */
export function createWakeLock() {
  let sentinel: WakeLockSentinel | null = null
  let wanted = false

  async function acquire() {
    if (!wanted || sentinel) return
    try {
      sentinel = await navigator.wakeLock?.request('screen')
      sentinel?.addEventListener('release', () => {
        sentinel = null
      })
    } catch {
      sentinel = null
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') void acquire()
  }

  return {
    async enable() {
      wanted = true
      document.addEventListener('visibilitychange', onVisibility)
      await acquire()
    },
    async disable() {
      wanted = false
      document.removeEventListener('visibilitychange', onVisibility)
      await sentinel?.release().catch(() => {})
      sentinel = null
    },
    get held() {
      return sentinel !== null
    },
  }
}
