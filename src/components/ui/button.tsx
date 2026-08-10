import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-2 font-medium select-none transition-[background,color,transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-leaf-500/60',
  {
    variants: {
      variant: {
        primary: 'bg-leaf-500 text-ink-950 hover:bg-leaf-400 shadow-lg shadow-leaf-500/20',
        solid: 'bg-ink-100 text-ink-950 hover:bg-white',
        subtle: 'bg-ink-700/70 text-ink-100 hover:bg-ink-600/70',
        ghost: 'text-ink-300 hover:text-ink-100 hover:bg-white/5',
        outline: 'border border-white/10 text-ink-100 hover:bg-white/5',
        danger: 'bg-rose-500/15 text-rose-500 hover:bg-rose-500/25',
      },
      size: {
        sm: 'h-9 px-3.5 text-[13px] rounded-xl',
        md: 'h-11 px-5 text-sm rounded-2xl',
        lg: 'h-14 px-7 text-base rounded-2xl',
        icon: 'size-11 rounded-2xl',
        iconSm: 'size-9 rounded-xl',
        iconLg: 'size-16 rounded-full',
      },
    },
    defaultVariants: { variant: 'subtle', size: 'md' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
)
Button.displayName = 'Button'
