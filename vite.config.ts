import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import path from 'node:path'

// HTTPS is not optional here: getUserMedia / WebRTC / OPFS are secure-context
// only. `localhost` is exempt, but phone1 hitting http://<laptop-lan-ip>:5173
// is not — `navigator.mediaDevices` would simply be undefined. The self-signed
// cert throws a one-time browser warning; accept it and everything works.
export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  base: './',
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    host: true,
    port: 5173,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
})
