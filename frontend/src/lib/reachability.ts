/** Доступность роутера: панель открыта (например, установленным приложением на телефоне),
 * а роутер не отвечает — телефон в другой сети, роутер перезагружается, пропал Wi-Fi. */

const PROBE_TIMEOUT_MS = 5000

export type LoginInfo = {
  enabled?: boolean
  has_password?: boolean
  authenticated?: boolean
  local?: boolean
}

/** Ответ `/api/auth/login` или `null`, если ответа нет. Ответ не JSON — тоже `null`: на этом адресе
 * в чужой сети может оказаться другое устройство или страница авторизации Wi-Fi. */
export async function probeRouter(): Promise<LoginInfo | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch('/api/auth/login', { cache: 'no-store', signal: controller.signal })
    if (!res.ok) return null
    const data: unknown = await res.json()
    return data && typeof data === 'object' ? (data as LoginInfo) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const listeners = new Set<() => void>()

/** Запрос к своему роутеру оборвался: пусть App проверит, на связи ли он. */
export function reportConnectionLost() {
  listeners.forEach((listener) => listener())
}

export function onConnectionLost(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
