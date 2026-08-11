/**
 * Minimal promise wrapper over IndexedDB.
 *
 * The frame *index* lives here (durable, transactional, range-queryable by
 * slot); the frame *bytes* live in OPFS. Both draw on the same origin quota.
 */

export const DB_NAME = 'plantlapse'
const DB_VERSION = 1
const FRAME_STORE = 'frames'
const META_STORE = 'meta'

export interface FrameRecord {
  /** Grid slot index — primary key, monotonic with time. */
  slot: number
  /** Wall-clock capture time on phone1 (ms). */
  t: number
  /** Ladder level; determines how long this frame survives. */
  level: number
  /** Mean luminance 0..255, used to paint the day/night scrubber. */
  lum: number
  /** Archive-resolution JPEG size in bytes. */
  loSize: number
  /** Native-resolution JPEG size, or 0 when no hi variant is stored. */
  hiSize: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(FRAME_STORE)) {
        db.createObjectStore(FRAME_STORE, { keyPath: 'slot' })
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(idbError(req.error, 'open'))
  })
  return dbPromise
}

/** IndexedDB reports failures as a nullable DOMException; normalise it. */
function idbError(err: DOMException | null, what: string) {
  return err ?? new Error(`IndexedDB ${what} failed`)
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(idbError(req.error, 'request'))
      }),
  )
}

export function putFrame(rec: FrameRecord) {
  return tx(FRAME_STORE, 'readwrite', (s) => s.put(rec))
}

export function deleteFrames(slots: number[]) {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(FRAME_STORE, 'readwrite')
        const store = t.objectStore(FRAME_STORE)
        for (const slot of slots) store.delete(slot)
        t.oncomplete = () => resolve()
        t.onerror = () => reject(idbError(t.error, 'delete'))
      }),
  )
}

export function getFrame(slot: number): Promise<FrameRecord | undefined> {
  return tx<FrameRecord | undefined>(
    FRAME_STORE,
    'readonly',
    (s) => s.get(slot) as IDBRequest<FrameRecord | undefined>,
  )
}

/** Frames in [fromSlot, toSlot], ascending. */
export function getFrameRange(fromSlot: number, toSlot: number): Promise<FrameRecord[]> {
  if (toSlot < fromSlot) return Promise.resolve([])
  return tx<FrameRecord[]>(
    FRAME_STORE,
    'readonly',
    (s) => s.getAll(IDBKeyRange.bound(fromSlot, toSlot)) as IDBRequest<FrameRecord[]>,
  )
}

export function countFrames(): Promise<number> {
  return tx<number>(FRAME_STORE, 'readonly', (s) => s.count())
}

function edgeFrame(direction: IDBCursorDirection): Promise<FrameRecord | null> {
  return openDb().then(
    (db) =>
      new Promise<FrameRecord | null>((resolve, reject) => {
        const t = db.transaction(FRAME_STORE, 'readonly')
        const req = t.objectStore(FRAME_STORE).openCursor(null, direction)
        req.onsuccess = () => resolve((req.result?.value as FrameRecord | undefined) ?? null)
        req.onerror = () => reject(idbError(req.error, 'cursor'))
      }),
  )
}

/** Oldest stored frame, or null when the archive is empty. */
export function getOldestFrame() {
  return edgeFrame('next')
}

export function getNewestFrame() {
  return edgeFrame('prev')
}

export function getMeta<T>(key: string): Promise<T | undefined> {
  return tx<T | undefined>(META_STORE, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
}

export function setMeta<T>(key: string, value: T) {
  return tx(META_STORE, 'readwrite', (s) => s.put(value, key))
}
