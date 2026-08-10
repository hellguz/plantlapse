import { useState } from 'react'
import { motion } from 'motion/react'
import { Camera, Eye, Sprout } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { navigate } from '@/lib/hash-route'
import { getSettings } from '@/lib/settings'
import { mediaSupported } from '@/lib/capture/camera'
import { webCodecsSupported } from '@/lib/bake/baker'
import { opfsSupported } from '@/lib/storage/opfs'

function Requirement({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={ok ? 'text-leaf-500' : 'text-rose-500'}>{ok ? '●' : '○'}</span>
      <span className={ok ? 'text-ink-400' : 'text-rose-500'}>{label}</span>
    </div>
  )
}

export default function Home() {
  const [secret, setSecret] = useState('')
  const canRig = mediaSupported() && webCodecsSupported() && opfsSupported()

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-sm"
      >
        <div className="mb-10 flex flex-col items-center text-center">
          <div className="mb-5 flex size-14 items-center justify-center rounded-[20px] bg-leaf-900 text-leaf-500">
            <Sprout size={26} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Plantlapse</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-400">
            One phone watches. The other one watches back — live, or six months rewound.
            Peer&nbsp;to&nbsp;peer, no server in between.
          </p>
        </div>

        <div className="space-y-3">
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!canRig}
            onClick={() => navigate('/rig')}
          >
            <Camera size={18} />
            Use this phone as the camera
          </Button>

          <div className="flex items-center gap-2 rounded-2xl border border-white/10 p-1.5 focus-within:border-leaf-500/40">
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value.trim().toLowerCase())}
              placeholder="pairing code"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="tnum min-w-0 flex-1 bg-transparent px-3 text-sm tracking-[0.18em] outline-none placeholder:tracking-normal placeholder:text-ink-500"
            />
            <Button
              size="sm"
              variant={secret ? 'solid' : 'ghost'}
              disabled={!secret}
              onClick={() => navigate(`/v/${secret}`)}
            >
              <Eye size={15} />
              Watch
            </Button>
          </div>
        </div>

        {!canRig && (
          <div className="mt-6 space-y-1.5 rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4">
            <div className="mb-2 text-xs font-semibold text-rose-500">
              This browser can&apos;t be the camera
            </div>
            <Requirement ok={mediaSupported()} label="Camera access (needs HTTPS)" />
            <Requirement ok={webCodecsSupported()} label="WebCodecs video encoding" />
            <Requirement ok={opfsSupported()} label="Origin private file system" />
            <p className="pt-1.5 text-[11px] leading-relaxed text-ink-400">
              Watching still works. Use Chrome on Android for the camera side.
            </p>
          </div>
        )}

        <button
          onClick={() => navigate(`/v/${getSettings().secret}`)}
          className="mt-8 w-full text-center text-[11px] text-ink-500 transition-colors hover:text-ink-300"
        >
          watch this device&apos;s own archive
        </button>
      </motion.div>
    </div>
  )
}
