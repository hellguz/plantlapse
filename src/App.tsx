import { useRoute } from '@/lib/hash-route'
import Home from '@/routes/Home'
import Rig from '@/routes/Rig'
import Viewer from '@/routes/Viewer'

export default function App() {
  const route = useRoute()

  if (route.name === 'rig') return <Rig />
  // Keyed by secret so switching rigs remounts with clean connection state.
  if (route.name === 'viewer') return <Viewer key={route.secret} secret={route.secret} />
  return <Home />
}
