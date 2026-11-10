import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { IconHelpCircle, IconInfoCircle } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { IPV6_CHANGED, loadIpv6Status } from '../../lib/ipv6'
import { Ipv6EnableDialog } from './Ipv6EnableDialog'

/** Адрес настроек основной сети, если панель открыта по IP роутера. */
function segmentSettingsUrl() {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname) ? `http://${location.hostname}/segments/Bridge0` : null
}

/**
 * IPv6 в основной сети выключен, а провайдер его даёт или его отключила панель (backend: ipv6.rs).
 * Баннер не закрывается: он исчезает, когда IPv6 вернут — здесь или в настройках роутера.
 */
export function Ipv6Notice() {
  const [visible, setVisible] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(
    () =>
      loadIpv6Status()
        .then((status) => setVisible(!!status.notice))
        .catch(() => {
          /* старый backend без этого адреса — баннера нет */
        }),
    []
  )

  useEffect(() => {
    void load()
    window.addEventListener(IPV6_CHANGED, load)
    return () => window.removeEventListener(IPV6_CHANGED, load)
  }, [load])

  if (!visible) return null
  const url = segmentSettingsUrl()

  return (
    <div className="flex items-start gap-3 rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sm text-sky-800 dark:text-sky-300">
      <IconInfoCircle className="mt-0.5 size-5 shrink-0" />
      <p className="flex-1">
        <span className="font-semibold">IPv6 в домашней сети отключён.</span> Устройства ходят через VPN по IPv4: многие VPN-серверы
        не поддерживают IPv6, и без этого часть сервисов, например Instagram, может не открываться.
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
          <p className="font-semibold">Зачем отключён IPv6</p>
          <p className="text-muted-foreground mt-1">
            Если провайдер даёт IPv6, телефоны открывают сервисы по IPv6-адресам, а VPN-сервер без IPv6 не может к ним
            подключиться. Поэтому IPv6 для устройств домашней сети выключен. У самого роутера IPv6 от провайдера работает как
            прежде.
          </p>
          <Button size="sm" className="mt-3 w-full" onClick={() => setConfirming(true)}>
            Вернуть IPv6
          </Button>
          <p className="text-muted-foreground mt-3">Или в веб-интерфейсе роутера:</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            <li>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer" className="underline">
                  Мои сети и Wi-Fi → Сегменты → Основная
                </a>
              ) : (
                'Мои сети и Wi-Fi → Сегменты → Основная'
              )}
            </li>
            <li>В блоке «Параметры IP» поставьте галочку «Включить IPv6».</li>
            <li>Сохраните. Баннер исчезнет, панель больше не будет отключать IPv6.</li>
          </ol>
        </PopoverContent>
      </Popover>
      <Ipv6EnableDialog open={confirming} onClose={() => setConfirming(false)} />
    </div>
  )
}
