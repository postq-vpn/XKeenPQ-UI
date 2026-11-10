import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useEffect, useState } from 'react'
import { acceptIpv6Off, loadIpv6Status, setIpv6 } from '../../lib/ipv6'
import { useAppActions } from '../../lib/store'

/** Сколько секунд кнопка «Принять» недоступна: сначала нужно прочитать объяснение. */
const ACCEPT_DELAY_S = 5

/**
 * Панель отключила IPv6 в домашней сети (backend: ipv6.rs). Окно показывается один раз на роутер:
 * выбор хранится на роутере. Закрыть его можно только выбором.
 */
export function Ipv6Dialog() {
  const { showToast } = useAppActions()
  const [open, setOpen] = useState(false)
  const [left, setLeft] = useState(ACCEPT_DELAY_S)
  const [busy, setBusy] = useState<'accept' | 'restore' | null>(null)

  useEffect(() => {
    loadIpv6Status()
      .then((status) => setOpen(status.ask))
      .catch(() => {
        /* старый backend без этого адреса — окна нет */
      })
  }, [])

  useEffect(() => {
    if (!open || left <= 0) return
    const timer = setTimeout(() => setLeft((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [open, left])

  async function choose(action: 'accept' | 'restore') {
    setBusy(action)
    try {
      if (action === 'accept') {
        await acceptIpv6Off()
      } else {
        await setIpv6(true)
        showToast('IPv6 в домашней сети включён. Переподключите устройства к Wi-Fi')
      }
      setOpen(false)
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>IPv6 в домашней сети отключён</DialogTitle>
          <DialogDescription render={<div />} className="space-y-2">
            <p>
              Ваш провайдер даёт IPv6, а многие VPN-серверы его не поддерживают. С IPv6 телефоны открывали бы Instagram и другие
              сервисы по IPv6-адресам, и через VPN такие сервисы не работали бы.
            </p>
            <p>
              Поэтому панель отключила IPv6 для устройств домашней сети: они ходят в интернет по IPv4. У самого роутера IPv6 от
              провайдера работает как прежде.
            </p>
            <p>
              Если IPv6 вам нужен, например для доступа к домашним устройствам по IPv6, верните его. Если после этого
              что-то перестанет открываться через VPN, IPv6 можно снова отключить в веб-интерфейсе роутера: «Мои сети и Wi-Fi» →
              «Сегменты» → «Основная» → «Включить IPv6».
            </p>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy !== null} onClick={() => void choose('restore')}>
            {busy === 'restore' && <Spinner className="size-4" />}
            Вернуть IPv6
          </Button>
          <Button disabled={busy !== null || left > 0} onClick={() => void choose('accept')}>
            {busy === 'accept' && <Spinner className="size-4" />}
            {left > 0 ? `Принять (${left})` : 'Принять'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
