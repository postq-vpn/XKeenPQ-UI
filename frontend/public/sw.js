// Service worker панели. Регистрируется только по HTTPS (например, через KeenDNS): по http://IP
// браузеры его не разрешают. Нужен одному: чтобы установленное приложение, открытое вне домашней сети,
// загрузилось из кеша и показало экран «Роутер недоступен», а не ошибку браузера.
// API и WebSocket не кешируются никогда — данные всегда с роутера.

const SHELL_CACHE = 'postq-shell'
const ASSETS_CACHE = 'postq-assets'
const SHELL_KEY = '/'
const NAVIGATION_TIMEOUT_MS = 8000

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return

  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
  } else if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request))
  }
})

/** Страница — всегда с роутера, если он ответил; кеш — только когда ответа нет. */
async function navigate(request) {
  try {
    const response = await fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS)
    if (response.ok) {
      await rememberShell(response.clone())
      return response
    }
    return (await cachedShell()) ?? response
  } catch (error) {
    const cached = await cachedShell()
    if (cached) return cached
    throw error
  }
}

/** Новая версия панели (другой index.html) — старые файлы сборки больше не нужны. */
async function rememberShell(response) {
  const cache = await caches.open(SHELL_CACHE)
  const previous = await cache.match(SHELL_KEY)
  const [next, before] = await Promise.all([response.clone().text(), previous ? previous.text() : null])
  if (next === before) return
  await caches.delete(ASSETS_CACHE)
  await cache.put(SHELL_KEY, response)
}

async function cachedShell() {
  const cache = await caches.open(SHELL_CACHE)
  return cache.match(SHELL_KEY)
}

/** Файлы сборки с хешем в имени не меняются: кеш без проверки. */
async function cacheFirst(request) {
  const cache = await caches.open(ASSETS_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

function fetchWithTimeout(request, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer))
}
