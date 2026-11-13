import { createRoot } from 'react-dom/client'

import App from './App.tsx'
import './globals.css'
import './lib/outboundParser.js'

createRoot(document.getElementById('root')!).render(<App />)

// Только по HTTPS: по http://IP браузер service worker не разрешит. В разработке не нужен — мешал бы Vite.
if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}
