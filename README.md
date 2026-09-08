# Plantlapse

Peer-to-peer plant timelapse. One phone watches; another watches back — live, or six
months rewound. No backend, no account, no server holding your frames.

## Running

```bash
pnpm install
pnpm dev      # https://<your-lan-ip>:5173
```

**HTTPS is not optional.** `getUserMedia`, WebRTC and OPFS are secure-context APIs.
`localhost` is exempt, but the phone hitting `http://192.168.x.x:5173` would find
`navigator.mediaDevices` undefined. The dev server uses a self-signed cert — accept the
browser warning once on each device.

| script | what it does |
| --- | --- |
| `pnpm dev` | dev server on the LAN, HTTPS |
| `pnpm build` | typecheck + production bundle into `dist/` |
| `pnpm check` | typecheck + eslint + knip |

## Using it

1. Open the site on **phone 1** (Chrome on Android) → *Use this phone as the camera*.
2. *Pair viewer* → scan the QR from **phone 2**, or type the code on its home screen.
3. *Start recording*, watch the frame counter move, then tap *Dim* — the screen only
   blacks out when you ask it to. Drop system brightness to zero as well. Recording is
   remembered, so a reload (or Android reaping the tab overnight) resumes it unasked.
4. On phone 2, pick a range — or `LIVE`, which is just the right-hand end of the timeline.
5. Drag anywhere on the picture, or on the strip, to scrub. From `LIVE` that is a peek
   back over the selected range; release and it snaps to the present.

## How it works

**Capture.** A frame every 2 s at the camera's native resolution, JPEG-encoded to an
archive copy (720p by default) plus a short-lived full-resolution copy for recent windows.
Bytes go to OPFS; the index goes to IndexedDB.

**The ladder.** Each frame's *level* is the trailing-zero count of its 2-second grid slot,
so "every frame with level ≥ n" is exactly the frames spaced `2s · 2ⁿ` apart, and every
coarse tier is a subset of the finer one. One stored file serves every zoom level.
Thinning is then one rule — a frame lives while its age is under its level's horizon:

| age | spacing | ≈ frames retained |
| --- | --- | --- |
| 0–6 h | 2 s | 10 800 |
| 6–12 h | 4 s | 5 400 |
| 12–24 h | 8 s | 5 400 |
| … doubling each band … | | |
| 128 d+ | 2048 s | forever |

Storage stays flat (~3–6 GB depending on archive resolution) while history keeps growing.

**Playback.** Streaming 10 000 JPEGs at 60 fps would be ~2.7 MB/s — hopeless over P2P.
Instead the rig hardware-encodes the requested window into an H.264 MP4 with WebCodecs
(`src/lib/bake/baker.worker.ts`), burning the capture timestamp into each frame so it
survives download. The viewer gets a real video file: native seeking, ±10 s, and a
download button that costs nothing extra. Clips are pre-baked in the background, so every
range opens instantly.

Windows of 6 h and up land at ~3 minutes at 60 fps. Shorter ones are deliberately
shorter — an hour of plant is not three minutes of content.

Seeks are coalesced: one in flight, the newest target queued behind it. Assigning
`currentTime` again cancels the seek already running, so a drag firing 60 of them a
second used to leave the picture frozen until the finger stopped.

**Rewinding out of live.** A clip cannot serve this: it is megabytes to download, and it
ends wherever the last bake ended, so it can never show you five minutes ago. Dragging on
the live view instead pulls single archive JPEGs straight off the rig — one datachannel
round trip each (~100 kB, no encode), snapped to the ladder grid so dragging back over
your own path is served from cache. The camera keeps publishing underneath the whole
time, which is why letting go snaps back to the present with nothing to reconnect. How
far back a full-width drag reaches is whichever range the chips last had selected.

**Transport.** Trystero over public Nostr relays for signalling, then direct WebRTC,
end-to-end encrypted. The pairing secret lives in the URL fragment and is the room id.

**What a viewer may do.** Watch, request clips, toggle the torch, and rotate the picture.
Not select a camera — which lens is open is decided at the phone that owns it, so a leaked
pairing link cannot repoint the lens at something else. Audio is never requested, and any
audio track is stopped and stripped before the stream can be published.

**Rotation** is a quarter turn applied at paint time on both phones, never baked in. So it
re-orients six months of existing frames the instant you set it, and costs the rig nothing.
The trade: the timestamp burned into a clip turns with the clip, and a downloaded MP4 keeps
the sensor's original orientation.

## Known limits

- **Screen can't be switched off.** No web API dims the panel, and Chrome for Android
  kills `getUserMedia` the instant the screen locks. Black fullscreen on AMOLED is the
  floor. Keep the phone plugged in.
- **Torch is Chrome-on-Android only.** WebKit ignores the `torch` constraint.
- **No TURN.** Public STUN covers most networks; two symmetric carrier-grade NATs will
  fail to connect. Same-WLAN always works.
- **Long uptime.** Android will eventually reap the tab. Capture resumes on reload and the
  timeline tolerates gaps, but expect to reopen it occasionally.

## Staying up for months

A rig left running for days used to go quiet with nothing to show for it: still
recording, still on screen, no error — and unreachable until someone reloaded the page.
Three separate things rot at that timescale, and each is now supervised on the rig itself.

**Relay subscriptions.** Trystero sends its Nostr `REQ` once, when the room is joined. The
websocket underneath it is reconnected when a relay drops us, but the subscription is not
replayed onto the new socket — so the rig goes on announcing into relays that have stopped
listening to it, and never hears the offer a viewer sends back. `src/lib/net/health.ts`
watches for a relay that is open *now* on a socket we never subscribed through, and the rig
rejoins the room when it sees one — which is what the reload was doing all along, minus the
reload. Rejoining also happens when the network returns, and after fifteen quiet minutes,
since a relay can fall silent in ways a socket check cannot see.

**The camera.** Android takes the sensor away without telling the page: a doze cycle,
another app, a notification. The track ends or mutes, frames stop, and nothing in the page
ever asks for the camera again. The rig now reopens it when the track ends, when it stays
muted for half a minute, or when it is recording and no frame has landed in a minute — and
keeps retrying if `getUserMedia` fails, rather than showing one error and giving up. The
torch is restored with the camera, so a reopen at 3am does not leave the plant in the dark.

**The wake lock.** It was taken once and re-taken on tab switch. A release from anywhere
else — a transient power-save state, a request that failed while the tab was hidden — was
permanent. It is now re-acquired on a timer for as long as recording is wanted.

On the viewer, a live track that goes `muted` while the data channel stays up (a frozen
picture behind a connected badge) triggers the same rejoin the rest of its watchdog uses.
