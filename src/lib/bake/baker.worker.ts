/// <reference lib="webworker" />
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from 'mediabunny'
import { framesForWindow } from '@/lib/storage/archive'
import { readFrame } from '@/lib/storage/opfs'
import { TARGET_FPS } from '@/lib/ladder'
import { formatStamp } from '@/lib/utils'
import type { BakeMessage, BakeRequest } from './protocol'

/**
 * Turns a slice of the frame archive into a real MP4.
 *
 * Shipping 10 000 individual JPEGs to the viewer would be ~2.7 MB/s at 60fps —
 * hopeless over P2P. A hardware-encoded H.264 clip of the same content is a few
 * tens of megabytes, seeks natively in a <video> element, and doubles as the
 * download artefact. The timestamp is burned in here so it survives that
 * download.
 */

const post = (msg: BakeMessage, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer)

/**
 * Trimmed ~a third below the obvious values. A plant barely moves between
 * frames, so H.264 spends its bits on the keyframes and the inter-frame
 * residual is nearly free — the visible quality loss is small and the clip
 * arrives over the datachannel proportionally sooner.
 */
function bitrateFor(height: number) {
  if (height >= 1080) return 3_400_000
  if (height >= 720) return 1_900_000
  return 1_100_000
}

/** Even dimensions only — H.264 chroma subsampling requires it. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Font and alignment are constant for a clip; only the text changes. */
function stampFont(ctx: OffscreenCanvasRenderingContext2D, h: number) {
  const size = Math.max(11, Math.round(h / 34))
  ctx.font = `500 ${size}px ui-monospace, "SF Mono", "Roboto Mono", monospace`
  ctx.textBaseline = 'bottom'
  ctx.textAlign = 'left'
  return size
}

function drawStamp(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  size: number,
  w: number,
  h: number,
) {
  const pad = Math.round(size * 0.9)
  const metrics = ctx.measureText(text)
  const boxW = metrics.width + pad * 1.2
  const boxH = size * 1.7

  ctx.save()
  ctx.globalAlpha = 0.42
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.roundRect(pad * 0.6, h - boxH - pad * 0.6, boxW, boxH, size * 0.4)
  ctx.fill()
  ctx.restore()

  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.fillText(text, pad * 1.2, h - pad * 1.05)
  void w
}

async function bake(req: BakeRequest) {
  const { windowId, spanMs, level, now, maxHeight } = req

  post({ type: 'progress', windowId, done: 0, total: 1, phase: 'indexing' })
  const recs = await framesForWindow(spanMs, level, now)
  if (recs.length < 2) {
    post({ type: 'error', windowId, message: `Only ${recs.length} frames in this window yet.` })
    return
  }

  // Native-resolution frames are only kept for the recent buffer; a window is
  // baked in hi only if every frame in it still has one.
  const variant: 'hi' | 'lo' = recs.every((r) => r.hiSize > 0) ? 'hi' : 'lo'

  const firstBlob = await readFrame(recs[0].slot, variant)
  if (!firstBlob) {
    post({ type: 'error', windowId, message: 'First frame missing from store.' })
    return
  }
  const probe = await createImageBitmap(firstBlob)
  const scale = Math.min(1, maxHeight / probe.height)
  const width = even(probe.width * scale)
  const height = even(probe.height * scale)
  probe.close()

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false })!
  const stampSize = stampFont(ctx, height)

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality({ bitrate: bitrateFor(height) }),
    // 1s GOP: bigger file, but scrubbing has to feel instant.
    keyFrameInterval: 1,
  })
  output.addVideoTrack(source, { frameRate: TARGET_FPS })
  await output.start()

  const timestamps = new Float64Array(recs.length)
  const dur = 1 / TARGET_FPS
  let encoded = 0

  /**
   * Two read-aheads, because the two stages are bounded by different things.
   *
   * Fetching is latency-bound: every frame is an OPFS handle lookup plus a read,
   * each an IPC round trip, and the only way to hide that is to have many in
   * flight. The bytes are cheap to hold — an archive JPEG is ~85KB, so a deep
   * queue is a few MB. Decoding is the opposite: a decoded 720p bitmap is 2.7MB,
   * so only a few can be alive at once, and it overlaps the encode well enough
   * at that depth anyway.
   */
  const FETCH_AHEAD = 32
  const DECODE_AHEAD = 4

  const fetchBytes = (rec: (typeof recs)[number]) =>
    readFrame(rec.slot, variant)
      // Pull the bytes here rather than letting createImageBitmap do it, so the
      // read is overlapped at fetch depth instead of decode depth.
      .then((blob) => blob?.arrayBuffer() ?? null)
      .catch(() => null) // gap or corrupt frame; drop it rather than the clip

  const decodeBytes = (bytes: ArrayBuffer | null) =>
    bytes
      ? createImageBitmap(
          new Blob([bytes], { type: 'image/jpeg' }),
          // Let the decoder do the downscale where there is one, instead of
          // decoding full size and throwing pixels away in drawImage.
          scale < 1 ? { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' } : {},
        ).catch(() => null)
      : Promise.resolve(null)

  const fetched: Array<Promise<ArrayBuffer | null>> = []
  const decoding: Array<Promise<ImageBitmap | null>> = []
  let fetchAt = 0

  const topUpFetches = () => {
    while (fetchAt < recs.length && fetched.length < FETCH_AHEAD) {
      fetched.push(fetchBytes(recs[fetchAt++]))
    }
  }
  /** Hand the oldest fetched frame to the decoder, if there is one waiting. */
  const topUpDecode = () => {
    const next = fetched.shift()
    if (next) decoding.push(next.then(decodeBytes))
  }

  topUpFetches()
  for (let i = 0; i < DECODE_AHEAD && i < recs.length; i++) topUpDecode()

  for (let i = 0; i < recs.length; i++) {
    const bmp = await decoding.shift()!
    topUpFetches()
    topUpDecode()
    if (!bmp) continue

    ctx.drawImage(bmp, 0, 0, width, height)
    bmp.close()
    drawStamp(ctx, formatStamp(recs[i].t), stampSize, width, height)

    timestamps[encoded] = recs[i].t
    // Awaited per frame on purpose: the sample is snapshotted synchronously, but
    // the encoder's keyframe and timing bookkeeping is not re-entrant, so
    // overlapping adds would corrupt the GOP structure.
    await source.add(encoded * dur, dur)
    encoded++

    if (encoded % 60 === 0 || i === recs.length - 1) {
      post({ type: 'progress', windowId, done: i + 1, total: recs.length, phase: 'encoding' })
    }
  }

  post({ type: 'progress', windowId, done: recs.length, total: recs.length, phase: 'muxing' })
  await output.finalize()

  const buffer = output.target.buffer
  if (!buffer) {
    post({ type: 'error', windowId, message: 'Muxer produced no output.' })
    return
  }

  const bytes = new Uint8Array(buffer)
  const stamps = timestamps.slice(0, encoded)

  post(
    {
      type: 'done',
      windowId,
      bytes,
      timestamps: stamps,
      width,
      height,
      durationS: encoded / TARGET_FPS,
      fromT: stamps[0] ?? now - spanMs,
      toT: stamps[encoded - 1] ?? now,
      level,
    },
    [bytes.buffer, stamps.buffer],
  )
}

self.onmessage = (e: MessageEvent<BakeRequest>) => {
  if (e.data?.type !== 'bake') return
  bake(e.data).catch((err) => {
    post({
      type: 'error',
      windowId: e.data.windowId,
      message: err instanceof Error ? err.message : String(err),
    })
  })
}
