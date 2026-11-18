import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Spinner } from '@/components/ui/spinner'
import { useState } from 'react'
import { setIpv6 } from '../../lib/ipv6'
import { useAppActions } from '../../lib/store'

/** Подтверждение перед включением IPv6 в домашней сети. */
export function Ipv6EnableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { showToast } = useAppActions()
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    try {
      await setIpv6(true)
      showToast('IPv6 в домашней сети включён. Переподключите устройства к Wi-Fi')
      onClose()
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader className="place-items-start gap-3 text-left">
          <AlertDialogTitle>Включить IPv6?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-2">
            <p>Многие VPN-серверы не работают с IPv6, поэтому часть сервисов, например Instagram, может перестать открываться через VPN.</p>
            <p>Если так случится, выключите IPv6 здесь же, в карточке «Роутер».</p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <AlertDialogAction disabled={busy} onClick={() => void confirm()}>
            {busy && <Spinner className="size-4" />}
            Включить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
