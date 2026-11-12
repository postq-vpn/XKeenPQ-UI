import { useCallback, useEffect, useRef, useState } from 'react'
import { serverName, usePing } from '../components/modals/XraySubscriptions'
import { withoutAutoServers } from '../components/modals/AutoServers'
import { apiCall } from './api'
import { useAppActions } from './store'
import type { XraySubscription } from './types'

interface ApiResult {
  success: boolean
  error?: string
  restart_error?: string | null
}

/** Как часто спрашивать у Xray, какой сервер выбран в режиме «Авто». */
const CURRENT_POLL_MS = 15000
/** Как часто перечитывать подписки при ручном выборе: панель сама включает «Авто», если сервер не отвечает. */
const FAILOVER_POLL_MS = 60_000

/**
 * Подписки Xray и их серверы — общее состояние главной: блок «Подписка» показывает
 * сами подписки, блок «VPN» — их серверы, пинг и выбор сервера.
 */
export function useSubscriptions({
  reloadKey,
  onLoaded,
  onChanged,
}: {
  /** Меняется, когда подписки изменились снаружи (добавлена новая) — список перечитывается. */
  reloadKey?: number
  /** Список подписок загружен — родитель решает, показать ли окно первого запуска. */
  onLoaded?: (subs: XraySubscription[]) => void
  /** Вызывается после изменения файлов outbounds, чтобы перечитать конфиги. */
  onChanged: () => void
}) {
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded
  const { showToast } = useAppActions()
  const [subs, setSubs] = useState<XraySubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [updatingTags, setUpdatingTags] = useState<string[]>([])
  const [savingServers, setSavingServers] = useState<string | null>(null)
  const { results: pings, ping } = usePing()
  /** Сервер, выбранный балансировщиком сейчас: тег подписки → тег сервера. */
  const [current, setCurrent] = useState<Record<string, string>>({})

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const res = await apiCall<ApiResult & { subscriptions?: XraySubscription[] }>('GET', 'subscriptions')
        if (!res.success) throw new Error(res.error)
        setSubs(res.subscriptions ?? [])
        onLoadedRef.current?.(res.subscriptions ?? [])
      } catch (e: any) {
        showToast(`Ошибка загрузки подписок: ${e.message}`, 'error')
      } finally {
        setLoading(false)
      }
    },
    [showToast]
  )

  // Первая загрузка — со скелетоном, перечитывание после изменений снаружи — тихое.
  useEffect(() => {
    void load(reloadKey !== undefined && reloadKey > 0)
  }, [load, reloadKey])

  // В режиме «Авто» сервер меняет сам Xray — периодически спрашиваем, какой выбран.
  const hasAuto = subs.some((s) => !s.primary)
  useEffect(() => {
    if (!hasAuto) {
      setCurrent({})
      return
    }
    let stopped = false
    const poll = async () => {
      try {
        const res = await apiCall<ApiResult & { current?: Record<string, string> }>('GET', 'subscriptions/current')
        if (!stopped && res.success) setCurrent(res.current ?? {})
      } catch {
        // Не критично: подпись останется общей.
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), CURRENT_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [hasAuto, subs])

  // Выбранный сервер не отвечает — панель сама включает «Авто», поэтому перечитываем подписки.
  const hasManual = subs.some((s) => !!s.primary)
  useEffect(() => {
    if (!hasManual) return
    const timer = setInterval(() => void load(true), FAILOVER_POLL_MS)
    return () => clearInterval(timer)
  }, [hasManual, load])

  // Пинг всех серверов после загрузки списка и когда серверы поменялись (например, добавили подписку).
  const serverTags = subs.flatMap((s) => withoutAutoServers(s.server_list).map((x) => x.tag)).join('\n')
  useEffect(() => {
    if (!loading && serverTags) void ping(subs.flatMap((s) => withoutAutoServers(s.server_list)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, serverTags, ping])

  const replaceSub = (next: XraySubscription) => setSubs((prev) => prev.map((s) => (s.tag === next.tag ? next : s)))

  async function selectServer(sub: XraySubscription, tag: string) {
    if (tag === sub.primary) return
    replaceSub({ ...sub, primary: tag })
    setSavingServers(sub.tag)
    try {
      const res = await apiCall<ApiResult & { subscription?: XraySubscription }>('POST', 'subscriptions/primary', {
        tag: sub.tag,
        primary: tag,
      })
      if (!res.success || !res.subscription) throw new Error(res.error)
      replaceSub(res.subscription)
      showToast(tag ? `Выбран сервер ${serverName(sub, tag)}` : 'Сервер выбирается автоматически')
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      onChanged()
    } catch (e: any) {
      replaceSub(sub)
      showToast(e.message || 'Не удалось выбрать сервер', 'error')
    } finally {
      setSavingServers(null)
    }
  }

  async function refresh(tag?: string) {
    setUpdatingTags(tag ? [tag] : subs.map((s) => s.tag))
    try {
      const res = await apiCall<ApiResult & { changed?: boolean; subscriptions?: XraySubscription[] }>('POST', 'subscriptions/refresh', {
        tag,
      })
      if (res.subscriptions) setSubs(res.subscriptions)
      if (!res.success) throw new Error(res.error)
      showToast(tag ? 'Подписка обновлена' : 'Подписки обновлены')
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      if (res.changed) onChanged()
    } catch (e: any) {
      showToast(`Ошибка обновления: ${e.message}`, 'error')
    } finally {
      setUpdatingTags([])
    }
  }

  async function remove(tag: string) {
    setUpdatingTags([tag])
    try {
      const res = await apiCall<ApiResult>('DELETE', `subscriptions?tag=${encodeURIComponent(tag)}`)
      if (!res.success) throw new Error(res.error)
      showToast('Подписка удалена')
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      setSubs((prev) => prev.filter((s) => s.tag !== tag))
      onChanged()
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      setUpdatingTags([])
    }
  }

  return {
    subs,
    loading,
    updatingTags,
    savingServers,
    pings,
    ping,
    current,
    load,
    selectServer,
    refresh,
    remove,
  }
}

export type SubscriptionsState = ReturnType<typeof useSubscriptions>
