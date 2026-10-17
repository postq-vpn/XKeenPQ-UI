import { REMOTE_FETCH_TIMEOUT_MS } from './multi-routers/model'

function apiPrefix(baseUrl?: string | null): string {
  return baseUrl ? `${baseUrl}/api` : '/api'
}

export async function apiCall<T = unknown>(
  method: string,
  endpoint: string,
  body?: unknown,
  options?: { baseUrl?: string | null; timeoutMs?: number; headers?: Record<string, string> }
): Promise<T> {
  const isGet = method === 'GET'
  const timeoutMs = options?.timeoutMs ?? (options?.baseUrl ? REMOTE_FETCH_TIMEOUT_MS : undefined)
  const controller = timeoutMs ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    const headers: Record<string, string> = { ...(options?.headers ?? {}) }
    if (!isGet) headers['Content-Type'] = 'application/json'
    const res = await fetch(`${apiPrefix(options?.baseUrl)}/${endpoint}`, {
      method,
      headers,
      body: !isGet ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    })
    return (await res.json()) as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export type FanOutResult = { id: string; ok: boolean; error?: string }

export async function fanOutRouters(
  targetIds: string[],
  task: (id: string, baseUrl: string | null) => Promise<void>,
  getBaseUrl: (id: string) => string | null
): Promise<FanOutResult[]> {
  const results = await Promise.allSettled(
    targetIds.map(async (id) => {
      await task(id, getBaseUrl(id))
      return id
    })
  )

  return results.map((result, index) => {
    const id = targetIds[index]
    if (result.status === 'fulfilled') return { id, ok: true }
    const error = result.reason instanceof Error ? result.reason.message : String(result.reason ?? 'Ошибка')
    return { id, ok: false, error }
  })
}

export function getFileLanguage(filename: string): string {
  if (filename.endsWith('.lst')) return 'plaintext'
  return 'json'
}

export function capitalize(str: string) {
  return str ? str[0].toUpperCase() + str.slice(1) : ''
}
