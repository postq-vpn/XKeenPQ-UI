import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext } from '../../lib/store'

const POLL_MS = 60_000

/**
 * Политику xkeen создали или изменили после запуска XKeen: он читает её только при запуске,
 * поэтому трафик идёт не по политике, пока XKeen не перезапустят (backend: /api/policy-status).
 */
export function PolicyWarning({ onRestarted }: { onRestarted: () => void }) {
  const { state, showToast } = useAppContext()
  const running = state.serviceStatus === 'running'
  const [outdated, setOutdated] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await apiCall<{ success: boolean; outdated: boolean }>('GET', 'policy-status')
      setOutdated(res.success && res.outdated)
    } catch {
      /* старый backend без этого адреса — предупреждения нет */
    }
  }, [])

  useEffect(() => {
    if (!running) return
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load, running])

  async function restart() {
    setRestarting(true)
    try {
      const res = await apiCall<{ success: boolean; error?: string }>('POST', 'control', { action: 'hardRestart' })
      if (!res.success) throw new Error(res.error || 'Не удалось перезапустить XKeen')
      showToast('XKeen перезапущен, политика применена')
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      setRestarting(false)
      onRestarted()
      void load()
    }
  }

  if (!running || !outdated) return null

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-400"
    >
      <IconAlertTriangle className="mt-0.5 size-5 shrink-0" />
      <div className="flex flex-col gap-1">
        <p className="font-semibold">Политика xkeen не применяется</p>
        <p>Её создали или изменили после запуска XKeen, поэтому устройства сейчас идут через VPN не по её настройкам.</p>
        <p className="text-amber-800/80 dark:text-amber-400/80">
          Перезапустите XKeen. Соединения прервутся на несколько секунд, логи Xray очистятся.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-1 w-fit border-amber-500/40 text-amber-800 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-400"
          disabled={restarting}
          onClick={() => void restart()}
        >
          {restarting ? <Spinner className="size-4" /> : <IconRefresh data-icon="inline-start" />}
          {restarting ? 'Перезапускаю XKeen…' : 'Перезапустить XKeen'}
        </Button>
      </div>
    </div>
  )
}
