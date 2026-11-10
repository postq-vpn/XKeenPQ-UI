import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { IconAlertTriangle, IconHelpCircle, IconInfoCircle } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { IPV6_CHANGED, type Ipv6Status, loadIpv6Status, setIpv6 } from '../../lib/ipv6'
import { useAppActions } from '../../lib/store'
import { Ipv6EnableDialog } from './Ipv6EnableDialog'

/** Как часто перечитывать состояние, пока панель открыта: IPv6 могут включить в роутере. */
const POLL_MS = 2 * 60 * 60 * 1000

/** Адрес настроек основной сети, если панель открыта по IP роутера. */
function segmentSettingsUrl() {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname) ? `http://${location.hostname}/segments/Bridge0` : null
}

/**
 * Узкий постоянный баннер про IPv6 в домашней сети (backend: ipv6.rs). Выключен — сообщение и
 * «Включить» с подтверждением; включён — предупреждение и «Отключить».
 */
export function Ipv6Notice() {
  const { showToast } = useAppActions()
  const [status, setStatus] = useState<Ipv6Status>({ available: false })
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    () =>
      loadIpv6Status()
        .then(setStatus)
        .catch(() => {
          /* старый backend без этого адреса — баннера нет */
        }),
    []
  )

  useEffect(() => {
    void load()
    const timer = setInterval(load, POLL_MS)
    window.addEventListener(IPV6_CHANGED, load)
    return () => {
      clearInterval(timer)
      window.removeEventListener(IPV6_CHANGED, load)
    }
  }, [load])

  async function disable() {
    setBusy(true)
    try {
      await setIpv6(false)
      showToast('IPv6 в домашней сети отключён. Переподключите устройства к Wi-Fi')
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!status.available) return null
  const enabled = !!status.enabled
  const url = segmentSettingsUrl()

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm',
        enabled
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-400'
          : 'border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300'
      )}
    >
      {enabled ? <IconAlertTriangle className="size-4 shrink-0" /> : <IconInfoCircle className="size-4 shrink-0" />}
      <p className="min-w-0 flex-1">
        {enabled ? 'IPv6 включён — может мешать VPN' : 'IPv6 в домашней сети отключён'}
      </p>
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="icon-xs" className="shrink-0" aria-label="Подробнее про IPv6">
              <IconHelpCircle className="size-4" />
            </Button>
          }
        />
        <PopoverContent className="w-80 text-sm">
          <p className="font-semibold">Почему IPv6 отключён</p>
          <p className="text-muted-foreground mt-1">
            Многие VPN-серверы не поддерживают IPv6. С ним телефоны открывают сервисы по IPv6-адресам, сервер не может к ним
            подключиться, и такие сервисы, например Instagram, через VPN не работают. Без IPv6 устройства ходят по IPv4. У
            самого роутера IPv6 от провайдера работает как прежде.
          </p>
          <p className="text-muted-foreground mt-2">
            То же в веб-интерфейсе роутера:{' '}
            {url ? (
              <a href={url} target="_blank" rel="noreferrer" className="underline">
                Мои сети и Wi-Fi → Сегменты → Основная
              </a>
            ) : (
              '«Мои сети и Wi-Fi» → «Сегменты» → «Основная»'
            )}
            , галочка «Включить IPv6». После переключения переподключите устройства к Wi-Fi.
          </p>
        </PopoverContent>
      </Popover>
      <Button
        variant="outline"
        size="xs"
        className="shrink-0"
        disabled={busy}
        onClick={() => (enabled ? void disable() : setConfirming(true))}
      >
        {busy && <Spinner className="size-3" />}
        {enabled ? 'Отключить' : 'Включить'}
      </Button>
      <Ipv6EnableDialog open={confirming} onClose={() => setConfirming(false)} />
    </div>
  )
}
