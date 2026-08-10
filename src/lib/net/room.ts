import { joinRoom, type Room } from 'trystero/nostr'
import { APP_ID, CH, type ClipHeader, type RigStatus, type ViewerCommand } from './protocol'

/**
 * Signalling rides on public Nostr relays — no server of ours anywhere. The
 * room id is the pairing secret, and Trystero encrypts everything end to end.
 *
 * Public STUN handles most NATs. Symmetric carrier-grade NAT on both ends still
 * needs a TURN relay; that is the one failure mode this design cannot fix, and
 * the UI reports it rather than hanging.
 */
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
}

export interface Channels {
  room: Room
  sendStatus: (s: RigStatus, to?: string | string[] | null) => void
  onStatus: (fn: (s: RigStatus, peerId: string) => void) => void
  sendCommand: (c: ViewerCommand, to?: string | string[] | null) => void
  onCommand: (fn: (c: ViewerCommand, peerId: string) => void) => void
  sendClipHeader: (h: ClipHeader, to?: string | string[] | null) => void
  onClipHeader: (fn: (h: ClipHeader, peerId: string) => void) => void
  sendClipData: (
    data: ArrayBuffer,
    to?: string | string[] | null,
    onProgress?: (pct: number, peerId: string) => void,
  ) => Promise<unknown>
  onClipData: (fn: (data: ArrayBuffer, peerId: string) => void) => void
  onClipProgress: (fn: (pct: number, peerId: string) => void) => void
  leave: () => void
}

type Send<T> = (
  data: T,
  to?: string | string[] | null,
  meta?: null,
  progress?: (pct: number, peerId: string) => void,
) => Promise<void[]>
type Receive<T> = (fn: (data: T, peerId: string) => void) => void
type Progress = (fn: (pct: number, peerId: string) => void) => void

/**
 * Trystero types payloads as `JsonValue`, which excludes plain interfaces
 * (no index signature). Our messages are structurally JSON, so the cast is
 * safe and keeps the call sites typed.
 */
function action<T>(room: Room, ns: string) {
  return room.makeAction(ns) as unknown as [Send<T>, Receive<T>, Progress]
}

export function createRoom(secret: string): Channels {
  const room = joinRoom({ appId: APP_ID, rtcConfig: RTC_CONFIG }, secret)

  const [sendStatus, onStatus] = action<RigStatus>(room, CH.status)
  const [sendCommand, onCommand] = action<ViewerCommand>(room, CH.command)
  const [sendClipHeader, onClipHeader] = action<ClipHeader>(room, CH.clipMeta)
  const [sendClipData, onClipData, onClipProgress] = action<ArrayBuffer>(room, CH.clipData)

  return {
    room,
    sendStatus: (s, to) => void sendStatus(s, to),
    onStatus: (fn) => onStatus((d, p) => fn(d, p)),
    sendCommand: (c, to) => void sendCommand(c, to),
    onCommand: (fn) => onCommand((d, p) => fn(d, p)),
    sendClipHeader: (h, to) => void sendClipHeader(h, to),
    onClipHeader: (fn) => onClipHeader((d, p) => fn(d, p)),
    sendClipData: (data, to, onProgress) => sendClipData(data, to, null, onProgress),
    onClipData: (fn) => onClipData((d, p) => fn(d, p)),
    onClipProgress: (fn) => onClipProgress((pct, p) => fn(pct, p)),
    leave: () => void room.leave(),
  }
}

/** Link the viewer opens; the secret stays in the hash so it never hits a log. */
export function viewerLink(secret: string) {
  const base = `${location.origin}${location.pathname}`
  return `${base}#/v/${secret}`
}
