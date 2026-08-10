import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { formatSpan, formatStamp } from '@/lib/utils'

/**
 * The armed state.
 *
 * A web page cannot switch the panel off — and Chrome for Android kills
 * getUserMedia the instant the screen locks, so it must stay on. Pure black on
 * AMOLED is the next best thing: unlit pixels draw essentially nothing. Drop
 * system brightness to zero and this is as close to "off" as capture allows.
 */
export function BlackScreen({
  frames,
  lastFrameAt,
  peers,
  onWake,
}: {
  frames: number
  lastFrameAt: number | null
  peers: number
  onWake: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!revealed) return
    const id = window.setTimeout(() => setRevealed(false), 6000)
    return () => clearTimeout(id)
  }, [revealed])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
      onClick={() => setRevealed((r) => !r)}
    >
      <AnimatePresence mode="wait">
        {revealed ? (
          <motion.div
            key="stats"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="px-8 text-center"
          >
            <div className="tnum text-3xl font-semibold text-ink-200">
              {frames.toLocaleString()}
            </div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-ink-600">
              frames captured
            </div>
            <div className="tnum mt-6 text-xs text-ink-500">
              {lastFrameAt ? formatStamp(lastFrameAt) : '—'}
            </div>
            <div className="mt-1 text-xs text-ink-600">
              {lastFrameAt ? `${formatSpan(now - lastFrameAt)} ago` : 'waiting'} · {peers} watching
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onWake()
              }}
              className="mt-8 rounded-full border border-white/10 px-5 py-2 text-xs text-ink-400"
            >
              show controls
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="dot"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="size-1.5 rounded-full bg-leaf-500 animate-pulse-soft"
          />
        )}
      </AnimatePresence>
    </div>
  )
}
