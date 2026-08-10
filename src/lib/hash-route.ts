import { useSyncExternalStore } from 'react'

/**
 * Hash routing, deliberately. The pairing secret lives in the fragment so it is
 * never sent to any server, and the whole app stays a static file drop.
 */
export type Route =
  | { name: 'home' }
  | { name: 'rig' }
  | { name: 'viewer'; secret: string }

function parse(hash: string): Route {
  const path = hash.replace(/^#/, '')
  if (path === '/rig') return { name: 'rig' }
  const m = /^\/v\/([a-z0-9]+)$/i.exec(path)
  if (m) return { name: 'viewer', secret: m[1] }
  return { name: 'home' }
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => location.hash,
    () => '',
  )
  return parse(hash)
}

export function navigate(path: string) {
  location.hash = path
}
