import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/* -------------------------------------------------------------------------- */
/* Chip / segmented range picker                                               */
/* -------------------------------------------------------------------------- */

export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  /** Dim the chip when the archive cannot fill this range yet. */
  muted?: boolean
}

export function Chip({ active, muted, className, children, ...props }: ChipProps) {
  return (
    <button
      className={cn(
        'relative shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold tracking-wide transition-colors duration-200',
        active ? 'text-ink-950' : muted ? 'text-ink-500' : 'text-ink-300 hover:text-ink-100',
        className,
      )}
      {...props}
    >
      {active && (
        <motion.span
          layoutId="chip-pill"
          className="absolute inset-0 rounded-full bg-leaf-500"
          transition={{ type: 'spring', stiffness: 520, damping: 40 }}
        />
      )}
      <span className="relative z-10">{children}</span>
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Switch                                                                      */
/* -------------------------------------------------------------------------- */

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-7 w-12 shrink-0 rounded-full transition-colors duration-300 disabled:opacity-40',
        checked ? 'bg-leaf-500' : 'bg-ink-700',
      )}
    >
      <motion.span
        className="absolute top-1 size-5 rounded-full bg-white shadow"
        animate={{ left: checked ? 26 : 4 }}
        transition={{ type: 'spring', stiffness: 600, damping: 38 }}
      />
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Row / field scaffolding                                                     */
/* -------------------------------------------------------------------------- */

export function Row({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4 py-3.5', className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-100">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-snug text-ink-400">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

export function Card({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('rounded-app border border-white/[0.06] bg-ink-850/60 p-4', className)}>
      {children}
    </div>
  )
}

export function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: 'default' | 'leaf' | 'ember' | 'rose'
}) {
  const toneClass = {
    default: 'text-ink-100',
    leaf: 'text-leaf-500',
    ember: 'text-ember-500',
    rose: 'text-rose-500',
  }[tone]
  return (
    <div className="rounded-2xl border border-white/[0.05] bg-ink-850/50 px-3.5 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">
        {label}
      </div>
      <div className={cn('tnum mt-1.5 text-lg leading-none font-semibold', toneClass)}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-ink-400">{sub}</div>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Bottom sheet                                                                */
/* -------------------------------------------------------------------------- */

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
}) {
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="glass safe-b fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-t-[28px] px-5 pt-3 sm:bottom-4 sm:rounded-[28px]"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragEnd={(_, info) => info.offset.y > 120 && onClose()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" />
            {title && (
              <div className="mb-1 flex items-center justify-between">
                <h2 className="text-base font-semibold">{title}</h2>
                <button
                  onClick={onClose}
                  className="rounded-full p-1.5 text-ink-400 hover:bg-white/5 hover:text-ink-100"
                >
                  <X size={18} />
                </button>
              </div>
            )}
            <div className="pb-4">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

/* -------------------------------------------------------------------------- */
/* Connection pill                                                             */
/* -------------------------------------------------------------------------- */

export function StatusDot({ tone }: { tone: 'live' | 'warn' | 'off' }) {
  const color =
    tone === 'live' ? 'bg-leaf-500' : tone === 'warn' ? 'bg-ember-500' : 'bg-ink-500'
  return (
    <span className="relative flex size-2">
      {tone !== 'off' && (
        <span className={cn('absolute inline-flex size-2 animate-ping rounded-full', color, 'opacity-60')} />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', color)} />
    </span>
  )
}
