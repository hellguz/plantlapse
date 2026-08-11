import { joinRoom, type Room } from 'trystero/nostr'
import {
  APP_ID,
  CH,
  type ClipHeader,
  type FrameMeta,
  type FrameRequest,
  type LumProfile,
  type LumRequest,
  type RigStatus,
  type ViewerCommand,
} from './protocol'

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
  sendFrameRequest: (r: FrameRequest, to?: string | string[] | null) => void
  onFrameRequest: (fn: (r: FrameRequest, peerId: string) => void) => void
  sendFrame: (bytes: ArrayBuffer, meta: FrameMeta, to?: string | string[] | null) => void
  onFrame: (fn: (bytes: ArrayBuffer, meta: FrameMeta, peerId: string) => void) => void
  sendLumRequest: (r: LumRequest, to?: string | string[] | null) => void
  onLumRequest: (fn: (r: LumRequest, peerId: string) => void) => void
  sendLumProfile: (p: LumProfile, to?: string | string[] | null) => void
  onLumProfile: (fn: (p: LumProfile, peerId: string) => void) => void
  leave: () => void
}

type Send<T, M = null> = (
  data: T,
  to?: string | string[] | null,
  meta?: M,
  progress?: (pct: number, peerId: string) => void,
) => Promise<void[]>
type Receive<T, M = undefined> = (fn: (data: T, peerId: string, meta: M) => void) => void
type Progress = (fn: (pct: number, peerId: string) => void) => void

/**
 * Trystero types payloads as `JsonValue`, which excludes plain interfaces
 * (no index signature). Our messages are structurally JSON, so the cast is
 * safe and keeps the call sites typed.
 */
function action<T, M = null>(room: Room, ns: string) {
  return room.makeAction(ns) as unknown as [Send<T, M>, Receive<T, M>, Progress]
}

export function createRoom(secret: string): Channels {
  const room = joinRoom({ appId: APP_ID, rtcConfig: RTC_CONFIG }, secret)

  const [sendStatus, onStatus] = action<RigStatus>(room, CH.status)
  const [sendCommand, onCommand] = action<ViewerCommand>(room, CH.command)
  const [sendClipHeader, onClipHeader] = action<ClipHeader>(room, CH.clipMeta)
  const [sendClipData, onClipData, onClipProgress] = action<ArrayBuffer>(room, CH.clipData)
  const [sendFrameRequest, onFrameRequest] = action<FrameRequest>(room, CH.frameReq)
  // The JPEG travels as the payload and its identity as metadata, so a frame
  // never has to be base64'd into JSON to carry its own timestamp.
  const [sendFrame, onFrame] = action<ArrayBuffer, FrameMeta>(room, CH.frameRes)
  const [sendLumRequest, onLumRequest] = action<LumRequest>(room, CH.lumReq)
  const [sendLumProfile, onLumProfile] = action<LumProfile>(room, CH.lumRes)

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
    sendFrameRequest: (r, to) => void sendFrameRequest(r, to),
    onFrameRequest: (fn) => onFrameRequest((d, p) => fn(d, p)),
    sendFrame: (bytes, meta, to) => void sendFrame(bytes, to, meta),
    onFrame: (fn) => onFrame((d, p, meta) => fn(d, meta, p)),
    sendLumRequest: (r, to) => void sendLumRequest(r, to),
    onLumRequest: (fn) => onLumRequest((d, p) => fn(d, p)),
    sendLumProfile: (p, to) => void sendLumProfile(p, to),
    onLumProfile: (fn) => onLumProfile((d, p) => fn(d, p)),
    leave: () => void room.leave(),
  }
}

/** Link the viewer opens; the secret stays in the hash so it never hits a log. */
export function viewerLink(secret: string) {
  const base = `${location.origin}${location.pathname}`
  return `${base}#/v/${secret}`
}
