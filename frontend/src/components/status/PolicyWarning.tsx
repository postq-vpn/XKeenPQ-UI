import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { IconAlertTriangle, IconRefresh, IconShieldPlus } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext } from '../../lib/store'

const POLL_MS = 60_000

interface CreateResult {
  success: boolean
  error?: string
  save_error?: string | null
  restart_error?: string | null
  hosts_outside?: number
}

/**
 * Состояние политики xkeen (backend: /api/policy-status). XKeen читает её только при запуске:
 * созданная позже не работает до перезапуска. Если политики нет, через VPN идут все устройства,
 * и панель предлагает создать её для основной сети.
 */
export function PolicyWarning({ onRestarted }: { onRestarted: () => void }) {
  const { state, showToast } = useAppContext()
  const running = state.serviceStatus === 'running'
  const [status, setStatus] = useState({ outdated: false, missing: false })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await apiCall<{ success: boolean; outdated: boolean; missing: boolean }>('GET', 'policy-status')
      if (res.success) setStatus({ outdated: res.outdated, missing: res.missing })
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
    setBusy(true)
    try {
      const res = await apiCall<{ success: boolean; error?: string }>('POST', 'control', { action: 'hardRestart' })
      if (!res.success) throw new Error(res.error || 'Не удалось перезапустить XKeen')
      showToast('XKeen перезапущен, политика применена')
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      setBusy(false)
      onRestarted()
      void load()
    }
  }

  async function create() {
    setBusy(true)
    try {
      const res = await apiCall<CreateResult>('POST', 'policy')
      if (!res.success) throw new Error(res.error || 'Не удалось создать политику')
      showToast('Политика создана для основной сети')
      if (res.hosts_outside) {
        showToast(`Устройств вне политики: ${res.hosts_outside}. Для них в роутере заданы свои настройки доступа`, 'error')
      }
      if (res.save_error) showToast(`Настройки роутера не сохранены: ${res.save_error}`, 'error')
      if (res.restart_error) showToast(`Не удалось перезапустить XKeen: ${res.restart_error}`, 'error')
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      setBusy(false)
      onRestarted()
      void load()
    }
  }

  async function hide() {
    try {
      const res = await apiCall<{ success: boolean; error?: string }>('PATCH', 'settings', { gui: { hide_policy_hint: true } })
      if (!res.success) throw new Error(res.error || 'Не удалось сохранить настройку')
      setStatus((s) => ({ ...s, missing: false }))
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }

  if (!running || (!status.outdated && !status.missing)) return null

  const buttonClass =
    'mt-1 w-fit border-amber-500/40 text-amber-800 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-400'

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-400"
    >
      <IconAlertTriangle className="mt-0.5 size-5 shrink-0" />
      {status.outdated ? (
        <div className="flex flex-col gap-1">
          <p className="font-semibold">Политика xkeen не применяется</p>
          <p>Её создали или изменили после запуска XKeen, поэтому устройства сейчас идут через VPN не по её настройкам.</p>
          <p className="text-amber-800/80 dark:text-amber-400/80">
            Перезапустите XKeen. Соединения прервутся на несколько секунд, логи Xray очистятся.
          </p>
          <Button variant="outline" size="sm" className={buttonClass} disabled={busy} onClick={() => void restart()}>
            {busy ? <Spinner className="size-4" /> : <IconRefresh data-icon="inline-start" />}
            {busy ? 'Перезапускаю XKeen…' : 'Перезапустить XKeen'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="font-semibold">Политики xkeen нет, через VPN идут все устройства</p>
          <p>Панель может создать её для основной сети: провод и основной Wi-Fi пойдут через VPN, остальные сегменты — мимо.</p>
          <p className="text-amber-800/80 dark:text-amber-400/80">Соединения прервутся на несколько секунд, логи Xray очистятся.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className={buttonClass} disabled={busy} onClick={() => void create()}>
              {busy ? <Spinner className="size-4" /> : <IconShieldPlus data-icon="inline-start" />}
              {busy ? 'Создаю политику…' : 'Создать политику и перезапустить XKeen'}
            </Button>
            <Button variant="ghost" size="sm" className="mt-1 w-fit" disabled={busy} onClick={() => void hide()}>
              Не показывать
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
