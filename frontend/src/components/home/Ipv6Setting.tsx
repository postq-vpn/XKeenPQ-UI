import { Switch } from '@/components/ui/switch'
import { ChevronDown as IconChevronDown } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { IPV6_CHANGED, type Ipv6Status, loadIpv6Status, setIpv6 } from '../../lib/ipv6'
import { useAppActions } from '../../lib/store'
import { cn } from '../../lib/utils'
import { Notice } from '../postq/ui'
import { Ipv6Dialog } from '../status/Ipv6Dialog'
import { Ipv6EnableDialog } from '../status/Ipv6EnableDialog'

/** Как часто перечитывать состояние: панель отключает IPv6 вскоре после запуска, а включить его могут и в роутере. */
const POLL_MS = 60_000

/** Адрес настроек основной сети, если панель открыта по IP роутера. */
function segmentSettingsUrl() {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname) ? `http://${location.hostname}/segments/Bridge0` : null
}

/**
 * IPv6 в домашней сети (backend: ipv6.rs) — строка в карточке «Роутер».
 * Переключатель: выключить сразу, включить — с подтверждением. Пояснение раскрывается по «Почему так».
 * После автоматического отключения поверх показывается окно с объяснением.
 */
export function Ipv6Setting() {
  const { showToast } = useAppActions()
  const [status, setStatus] = useState<Ipv6Status>({ available: false })
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const panelId = useId()

  const load = useCallback(
    () =>
      loadIpv6Status()
        .then(setStatus)
        .catch(() => {
          /* старый backend без этого адреса — строки нет */
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
    <div className="flex flex-col gap-(--rd-space-group) border-t border-[var(--rd-divider)] pt-(--rd-space-card)">
      <div className="flex items-start justify-between gap-(--rd-space-group)">
        <div className="flex min-w-0 flex-col gap-(--rd-space-title)">
          <label htmlFor={`${panelId}-switch`} className="rd-body cursor-pointer text-[var(--rd-heading)]">
            IPv6 в домашней сети
          </label>
          <p className="rd-meta">
            {enabled ? 'Включён — часть сервисов может открываться мимо VPN' : 'Отключён — так VPN работает надёжнее'}
          </p>
        </div>
        <Switch
          id={`${panelId}-switch`}
          checked={enabled}
          disabled={busy}
          onCheckedChange={(next) => (next ? setConfirming(true) : void disable())}
          className="mt-0.5"
        />
      </div>

      {enabled && (
        <Notice tone="warning" title="IPv6 может мешать VPN" text="Отключите его, если какие-то сервисы не открываются через VPN." />
      )}

      <div className="flex flex-col">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="rd-meta rd-link-action flex w-fit items-center gap-1 text-[var(--rd-action)]"
        >
          Почему так
          <IconChevronDown size={16} className={cn('transition-transform duration-300', open && 'rotate-180')} />
        </button>
        <div id={panelId} className="rd-disclosure" data-open={open}>
          <div className="rd-disclosure__inner">
            <div className="rd-meta flex flex-col gap-(--rd-space-item) pt-(--rd-space-item) text-[var(--rd-body)]">
              <p>
                Многие VPN-серверы не поддерживают IPv6. С ним телефоны открывают сервисы по IPv6-адресам, сервер не может к ним
                подключиться — и такие сервисы, например Instagram, через VPN не работают. Без IPv6 устройства ходят по IPv4, а у самого
                роутера IPv6 от провайдера работает как прежде.
              </p>
              <p>
                То же в веб-интерфейсе роутера:{' '}
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="rd-link-action underline underline-offset-2">
                    Мои сети и Wi-Fi → Сегменты → Основная
                  </a>
                ) : (
                  '«Мои сети и Wi-Fi» → «Сегменты» → «Основная»'
                )}
                , галочка «Включить IPv6». После переключения переподключите устройства к Wi-Fi.
              </p>
            </div>
          </div>
        </div>
      </div>

      <Ipv6EnableDialog open={confirming} onClose={() => setConfirming(false)} />
      <Ipv6Dialog open={!!status.ask} onClose={() => setStatus((s) => ({ ...s, ask: false }))} />
    </div>
  )
}
