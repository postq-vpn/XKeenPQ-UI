import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { IconAlertTriangle, IconDownload } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppActions } from '../../lib/store'

const POLL_MS = 60_000

interface Status {
  pending: boolean
  missing: string[]
}

/**
 * Маршрутизация по умолчанию не поставлена: не хватает geo-файлов или outbound'ов (backend:
 * routing_pending). Предупреждение не закрывается — исчезает само, когда роутер поставит
 * маршрутизацию (он проверяет раз в минуту).
 */
export function RoutingWarning({ reloadKey }: { reloadKey: number }) {
  const { showToast } = useAppActions()
  const [status, setStatus] = useState<Status | null>(null)
  const [downloading, setDownloading] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await apiCall<{ success: boolean } & Status>('GET', 'subscriptions/routing-status')
      if (res.success) setStatus(res)
    } catch {
      /* старый backend без этого адреса — предупреждения нет */
    }
  }, [])

  // Проверяем при открытии и после изменений подписок; раз в минуту — только пока предупреждение
  // на экране (ждём, когда роутер сам поставит маршрутизацию).
  useEffect(() => {
    void load()
  }, [load, reloadKey])
  const pending = !!status?.pending
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load, pending])

  /** Роутер качает недостающие геобазы, включает их автообновление и ставит маршрутизацию. */
  async function download() {
    setDownloading(true)
    try {
      const res = await apiCall<{
        success: boolean
        error?: string
        routing_applied?: boolean
        restart_error?: string
      }>('POST', 'subscriptions/geo-download')
      if (!res.success) throw new Error(res.error || 'Не удалось скачать геобазы')
      showToast(
        res.routing_applied
          ? 'Геобазы скачаны, маршрутизация включена. Автообновление геобаз — раз в сутки'
          : 'Геобазы скачаны. Автообновление — раз в сутки'
      )
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      setDownloading(false)
      void load()
    }
  }

  if (!status?.pending) return null
  const files = status.missing.filter((m) => !m.startsWith('outbound'))
  const outbounds = status.missing.filter((m) => m.startsWith('outbound'))

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400"
    >
      <IconAlertTriangle className="mt-0.5 size-5 shrink-0" />
      <div className="flex flex-col gap-1">
        <p className="font-semibold">Маршрутизация не настроена — VPN может работать неправильно</p>
        {files.length > 0 && <p>На роутере не хватает геобаз — списков сайтов, которые идут через VPN.</p>}
        {outbounds.length > 0 && <p>В настройках Xray на роутере не хватает обязательных частей.</p>}
        <p className="text-red-700/80 dark:text-red-400/80">
          Как только всё появится, панель сама включит маршрутизацию, и это сообщение исчезнет.
        </p>
        {files.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="mt-1 w-fit border-red-500/40 text-red-700 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-400"
            disabled={downloading}
            onClick={() => void download()}
          >
            {downloading ? <Spinner className="size-4" /> : <IconDownload data-icon="inline-start" />}
            {downloading ? 'Скачиваю геобазы…' : 'Скачать геобазы и включить автообновление'}
          </Button>
        )}
      </div>
    </div>
  )
}
