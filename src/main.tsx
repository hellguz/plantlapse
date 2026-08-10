import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// No StrictMode: its double-invoked effects would open the camera twice and
// join/leave the signalling room on every mount, which WebRTC does not enjoy.
createRoot(document.getElementById('root')!).render(<App />)
