import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Copy } from 'lucide-react'
import { Sheet } from '@/components/ui/primitives'
import { Button } from '@/components/ui/button'
import { viewerLink } from '@/lib/net/room'

export function PairSheet({
  open,
  onClose,
  secret,
}: {
  open: boolean
  onClose: () => void
  secret: string
}) {
  const [png, setPng] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const link = viewerLink(secret)

  useEffect(() => {
    if (!open) return
    void QRCode.toDataURL(link, {
      width: 640,
      margin: 1,
      color: { dark: '#0a0a0b', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).then(setPng)
  }, [open, link])

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked — the code is on screen anyway */
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Pair a viewer">
      <p className="mb-5 text-sm leading-relaxed text-ink-400">
        Scan from the other device, or type the code on the Plantlapse home screen. The code is the
        only key — it never leaves your two devices.
      </p>

      <div className="mx-auto mb-5 w-fit rounded-3xl bg-white p-3">
        {png ? (
          <img src={png} alt="Pairing QR code" className="size-52 rounded-xl" />
        ) : (
          <div className="size-52 animate-pulse rounded-xl bg-ink-200" />
        )}
      </div>

      <div className="tnum mb-4 text-center text-lg tracking-[0.3em] text-leaf-500">{secret}</div>

      <Button variant="subtle" size="md" className="w-full" onClick={() => void copy()}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
        {copied ? 'Link copied' : 'Copy viewer link'}
      </Button>
    </Sheet>
  )
}
