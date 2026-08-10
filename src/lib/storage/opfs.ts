/**
 * OPFS blob store.
 *
 * Frames are sharded into directories of SHARD_SLOTS grid slots each, so a
 * six-month archive never puts more than a few thousand files in one directory
 * and fully-aged shards can be dropped with a single recursive remove.
 */

const SHARD_SLOTS = 4096

export type Variant = 'lo' | 'hi'

let rootPromise: Promise<FileSystemDirectoryHandle> | null = null

function root() {
  rootPromise ??= navigator.storage.getDirectory()
  return rootPromise
}

export function opfsSupported() {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
}

async function dir(name: string, create = true) {
  return (await root()).getDirectoryHandle(name, { create })
}

function shardFor(slot: number) {
  return Math.floor(slot / SHARD_SLOTS)
}

async function frameShard(slot: number, create = true) {
  const frames = await dir('frames', create)
  return frames.getDirectoryHandle(String(shardFor(slot)), { create })
}

function frameName(slot: number, variant: Variant) {
  return `${slot}.${variant}.jpg`
}

export async function writeFrame(slot: number, variant: Variant, data: Blob | Uint8Array) {
  const shard = await frameShard(slot)
  const fh = await shard.getFileHandle(frameName(slot, variant), { create: true })
  const w = await fh.createWritable()
  await w.write(data as FileSystemWriteChunkType)
  await w.close()
}

export async function readFrame(slot: number, variant: Variant): Promise<Blob | null> {
  try {
    const shard = await frameShard(slot, false)
    const fh = await shard.getFileHandle(frameName(slot, variant))
    return await fh.getFile()
  } catch {
    return null
  }
}

export async function deleteFrame(slot: number, variant: Variant) {
  try {
    const shard = await frameShard(slot, false)
    await shard.removeEntry(frameName(slot, variant))
  } catch {
    /* already gone */
  }
}

/** Remove shard directories strictly older than the given slot. */
export async function pruneShardsBefore(slot: number) {
  const cutoff = shardFor(slot)
  const frames = (await dir('frames')) as FileSystemDirectoryHandle & {
    // Async iteration over directory handles is not in lib.dom yet.
    keys: () => AsyncIterable<string>
  }
  const stale: string[] = []
  for await (const name of frames.keys()) {
    const n = Number(name)
    if (Number.isFinite(n) && n < cutoff) stale.push(name)
  }
  for (const name of stale) {
    await frames.removeEntry(name, { recursive: true }).catch(() => {})
  }
  return stale.length
}

/* -------------------------------------------------------------------------- */
/* Baked clips                                                                 */
/* -------------------------------------------------------------------------- */

export async function writeClip(id: string, bytes: Uint8Array) {
  const clips = await dir('clips')
  const fh = await clips.getFileHandle(`${id}.mp4`, { create: true })
  const w = await fh.createWritable()
  await w.write(bytes as unknown as FileSystemWriteChunkType)
  await w.close()
}

export async function readClip(id: string): Promise<Blob | null> {
  try {
    const clips = await dir('clips', false)
    const fh = await clips.getFileHandle(`${id}.mp4`)
    return await fh.getFile()
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */

export async function storageEstimate() {
  const est = await navigator.storage?.estimate?.()
  return {
    usage: est?.usage ?? 0,
    quota: est?.quota ?? 0,
  }
}

/** Ask for eviction-proof storage. Much likelier to be granted once installed. */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}

export async function isPersisted() {
  return (await navigator.storage?.persisted?.()) ?? false
}

/** Nuke everything — used by the "reset archive" action. */
export async function wipeAll() {
  const r = await root()
  for (const name of ['frames', 'clips']) {
    await r.removeEntry(name, { recursive: true }).catch(() => {})
  }
}
