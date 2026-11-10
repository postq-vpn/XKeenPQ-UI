import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Spinner } from '@/components/ui/spinner'
import { IconAlertTriangle } from '@tabler/icons-react'
import { useState } from 'react'
import { setIpv6 } from '../../lib/ipv6'
import { useAppActions } from '../../lib/store'

/** Подтверждение перед возвратом IPv6 в домашнюю сеть. */
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
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <IconAlertTriangle />
          </AlertDialogMedia>
          <AlertDialogTitle>Вернуть IPv6 в домашнюю сеть?</AlertDialogTitle>
          <AlertDialogDescription>
            Устройства получат IPv6-адреса и будут открывать сервисы по IPv6. Многие VPN-серверы IPv6 не поддерживают, и часть
            сервисов, например Instagram, может перестать открываться. Если что-то перестанет работать, отключите IPv6 в
            веб-интерфейсе роутера: «Мои сети и Wi-Fi» → «Сегменты» → «Основная» → «Включить IPv6».
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <AlertDialogAction disabled={busy} onClick={() => void confirm()}>
            {busy && <Spinner className="size-4" />}
            Вернуть
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
